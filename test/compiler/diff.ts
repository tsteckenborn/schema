import { pipe } from "@effect/data/Function"
import * as ReadonlyArray from "@effect/data/ReadonlyArray"
import * as A from "@effect/schema/Arbitrary"
import * as AST from "@effect/schema/AST"
import * as I from "@effect/schema/internal/common"
import * as S from "@effect/schema/Schema"
import * as fc from "fast-check"
import * as jsonpatch from "fast-json-patch"

import * as Either from "@effect/data/Either"

/*

Looks like JSONPatch is not reversible: for example, if we take the `replace` operation:

```
{ "op": "replace", "path": "/biscuits/0/name", "value": "Chocolate Digestive" }
```

the value to be replaced is not included, AFAIK so there's no official way to derive the reverse operation.

Also I'm not sure having a `path: string` is good (even if we use a `ReadonlyArray<symbol | string | number>` instead of `string`).

So for my POC I opted for a recursive custom language with more information (from which we can always derive JSONPatch if needed),
similar to https://github.com/IMax153/scrapelog/blob/ce17f1ade4f61eacf8ff24aae2aa36aa7fa33793/src/diff.ts
(but smaller).

Open questions:

- what to do with excess properties?
- should patches be serializable?

Not sure what are the following (from https://github.com/IMax153/scrapelog/blob/ce17f1ade4f61eacf8ff24aae2aa36aa7fa33793/test/differ.ts):

- remove unnecessary steps (not necessary?)
- remove empty patches (why?)
- optimize for sql... (???)
- custom schema for fractional indexed arrays (as list of tuple: [f-index, value]) (???)
- schema todo: support ordered arrays (for fractional indexing) (???)

*/

// -------------------------------------------------------------------------------------
// ops
// -------------------------------------------------------------------------------------

export type Op = Identical | Replace | ObjectOps

export type ObjectOp = Replace | ObjectOps | Add | Remove

export interface Identical {
  readonly _tag: "Identical"
}

export const identical: Identical = ({ _tag: "Identical" })

export const isIdentical = (op: Op): op is Identical => op._tag === "Identical"

export interface Replace {
  readonly _tag: "Replace"
  readonly from: unknown
  readonly to: unknown
}

export const replace = (from: Replace["from"], to: Replace["to"]): Replace => ({
  _tag: "Replace",
  from,
  to
})

export interface ObjectOps {
  readonly _tag: "ObjectOps"
  readonly ops: ReadonlyArray.NonEmptyReadonlyArray<[PropertyKey, ObjectOp]>
}

export const objectOps = (ops: ObjectOps["ops"]): ObjectOps => ({
  _tag: "ObjectOps",
  ops
})

export interface Add {
  readonly _tag: "Add"
  readonly value: unknown
}

export const add = (value: unknown): Add => ({ _tag: "Add", value })

export interface Remove {
  readonly _tag: "Remove"
  readonly value: unknown
}

export const remove = (value: unknown): Remove => ({ _tag: "Remove", value })

const reverseReplace = (op: Replace): Replace => replace(op.to, op.from)

const reverseObjectOps = (op: ObjectOps): ObjectOps =>
  objectOps(
    ReadonlyArray.mapNonEmpty(op.ops, ([key, op]) => [key, reverseObjectOp(op)])
  )

const reverseOp = (op: Op): Op => {
  switch (op._tag) {
    case "Identical":
      return op
    case "Replace":
      return reverseReplace(op)
    case "ObjectOps":
      return reverseObjectOps(op)
  }
}

const reverseObjectOp = (op: ObjectOp): ObjectOp => {
  switch (op._tag) {
    case "Replace":
      return reverseReplace(op)
    case "ObjectOps":
      return reverseObjectOps(op)
    case "Add":
      return remove(op.value)
    case "Remove":
      return add(op.value)
  }
}

// -------------------------------------------------------------------------------------
// Patch
// -------------------------------------------------------------------------------------

export interface Patch<A> {
  readonly A: (_: A) => A
  readonly op: Op
}

export const make = <A>(op: Op): Patch<A> => ({ op }) as any

export const reverse = <A>(patch: Patch<A>): Patch<A> => make(reverseOp(patch.op))

// STATUS: incomplete (ArrayOps missing)
export const runPatch = <A>(patch: Patch<A>): (a: A) => A => runOp(patch.op)

const runOp = (op: Op) =>
  (a: any): any => {
    switch (op._tag) {
      case "Identical":
        return a
      case "Replace":
        return op.to
      case "ObjectOps": {
        const out = { ...a }
        for (const [name, subop] of op.ops) {
          switch (subop._tag) {
            case "Replace":
            case "ObjectOps":
              out[name] = runOp(subop)(a[name])
              break
            case "Add":
              out[name] = subop.value
              break
            case "Remove":
              delete out[name]
          }
        }
        return out
      }
    }
  }

// -------------------------------------------------------------------------------------
// Differ
// -------------------------------------------------------------------------------------

export interface Differ<A> {
  (from: A, to: A): Patch<A>
}

// STATUS: incomplete (ArrayOps missing)
export const fromSchema = <I, A>(schema: S.Schema<I, A>): Differ<A> => go(AST.to(schema.ast))

const go = (ast: AST.AST): Differ<any> => {
  switch (ast._tag) {
    case "NumberKeyword":
      return (from, to) => make(Object.is(from, to) ? identical : replace(from, to))
    case "Declaration":
    case "Literal":
    case "UniqueSymbol":
    case "UndefinedKeyword":
    case "VoidKeyword":
    case "NeverKeyword":
    case "UnknownKeyword":
    case "AnyKeyword":
    case "StringKeyword":
    case "BooleanKeyword":
    case "BigIntKeyword":
    case "SymbolKeyword":
    case "ObjectKeyword":
    case "Enums":
    case "TemplateLiteral":
    case "Union":
    case "Tuple":
      // TODO
    case "Transform":
      return (from, to) => make((from === to) ? identical : replace(from, to))
    case "Refinement":
      return go(ast.from)
    case "Lazy":
      return go(ast.f())
    case "TypeLiteral": {
      const propertySignatures = ast.propertySignatures.map((ps) => go(ps.type))
      const indexSignatures = ast.indexSignatures.map((is) => go(is.type))
      const expectedKeys: any = {}
      for (let i = 0; i < propertySignatures.length; i++) {
        expectedKeys[ast.propertySignatures[i].name] = null
      }
      return (from, to) => {
        const ops: Array<[PropertyKey, ObjectOp]> = []
        // ---------------------------------------------
        // handle property signatures
        // ---------------------------------------------
        for (let i = 0; i < propertySignatures.length; i++) {
          const ps = ast.propertySignatures[i]
          const differ = propertySignatures[i]
          const name = ps.name
          if (Object.prototype.hasOwnProperty.call(from, name)) {
            if (Object.prototype.hasOwnProperty.call(to, name)) {
              const op = differ(from[name], to[name]).op
              if (!isIdentical(op)) {
                ops.push([name, op])
              }
            } else {
              ops.push([name, remove(from[name])])
            }
          } else {
            if (Object.prototype.hasOwnProperty.call(to, name)) {
              ops.push([name, add(to[name])])
            }
          }
        }
        // ---------------------------------------------
        // handle index signatures
        // ---------------------------------------------
        if (indexSignatures.length > 0) {
          for (let i = 0; i < indexSignatures.length; i++) {
            const differ = indexSignatures[i]
            const fromKeys = I.getKeysForIndexSignature(from, ast.indexSignatures[i].parameter)
            for (const name of fromKeys) {
              if (Object.prototype.hasOwnProperty.call(expectedKeys, name)) {
                continue
              }
              if (Object.prototype.hasOwnProperty.call(to, name)) {
                const op = differ(from[name], to[name]).op
                if (!isIdentical(op)) {
                  ops.push([name, op])
                }
              } else {
                ops.push([name, remove(from[name])])
              }
            }
            const toKeys = I.getKeysForIndexSignature(to, ast.indexSignatures[i].parameter)
            for (const name of toKeys) {
              if (Object.prototype.hasOwnProperty.call(expectedKeys, name)) {
                continue
              }
              if (!Object.prototype.hasOwnProperty.call(from, name)) {
                ops.push([name, add(to[name])])
              }
            }
          }
        }

        return make(ReadonlyArray.isNonEmptyReadonlyArray(ops) ? objectOps(ops) : identical)
      }
    }
  }
}

// -------------------------------------------------------------------------------------
// JSONPatch
// -------------------------------------------------------------------------------------

type JSONPatch =
  | { readonly op: "add"; readonly path: string; readonly value: S.Json }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "replace"; readonly path: string; readonly value: S.Json }

const getJSONPointer = (path: Array<string>): string =>
  /*
   Because the characters '~' (%x7E) and '/' (%x2F) have special
   meanings in JSON Pointer, '~' needs to be encoded as '~0' and '/'
   needs to be encoded as '~1' when these characters appear in a
   reference token.

   https://datatracker.ietf.org/doc/html/rfc6901#section-3
   */
  path.map((s) => "/" + s.replaceAll("~", "~0").replaceAll("/", "~1")).join("")

const validateJson = (a: unknown) => S.validate(S.json)(a, { onExcessProperty: "error" })

const validateString = S.validate(S.string)

const isJson = (a: unknown): a is S.Json =>
  Either.isRight(S.validateEither(S.json)(a, { onExcessProperty: "error" }))

// STATUS: experimental (Not thoroughly tested)
export const getJSONPatch = Either.liftThrowable((op: Op): Array<JSONPatch> => {
  const out: Array<JSONPatch> = []
  const path: Array<string> = []
  const objectOps = (op: ObjectOps) => {
    op.ops.forEach(([key, op]) => {
      path.push(validateString(key))
      switch (op._tag) {
        case "Replace":
          out.push({ op: "replace", path: getJSONPointer(path), value: validateJson(op.to) })
          break
        case "ObjectOps":
          objectOps(op)
          break
        case "Add":
          out.push({ op: "add", path: getJSONPointer(path), value: validateJson(op.value) })
          break
        case "Remove":
          out.push({ op: "remove", path: getJSONPointer(path) })
          break
      }
      path.shift()
    })
  }
  switch (op._tag) {
    case "Identical":
      break
    case "Replace":
      out.push({ op: "replace", path: "", value: validateJson(op.to) })
      break
    case "ObjectOps":
      objectOps(op)
      break
  }
  return out
}, (e) => e instanceof Error ? e : new Error(String(e)))

// -------------------------------------------------------------------------------------
// tests
// -------------------------------------------------------------------------------------

const debug = false

const property = <I, A>(schema: S.Schema<I, A>) => {
  const differ = fromSchema(schema)
  const arb = A.to(schema)(fc)
  if (debug) {
    const [from, to] = fc.sample(arb, 2)
    const patch = differ(from, to)
    console.log("%o", patch)
  }
  fc.assert(fc.property(arb, arb, (from, to) => {
    // test identical
    expect(differ(from, from).op).toEqual(identical)
    // test non identical
    const patch = differ(from, to)
    // test run patch
    expect(runPatch(patch)(from)).toEqual(to)
    expect(runPatch(reverse(patch))(to)).toEqual(from)
    // test jsonPatch
    const jp = getJSONPatch(patch.op)
    if (isJson(from) && isJson(to) && Either.isRight(jp)) {
      expect(
        jsonpatch.applyPatch(from, jp.right, undefined, false)
          .newDocument
      ).toEqual(to)
    }
  }))
}

describe.concurrent("diff", () => {
  it("should handle NaN", () => {
    const differ = fromSchema(S.number)
    const patch = differ(NaN, 0)
    expect(patch.op).toStrictEqual(replace(NaN, 0))
  })

  it("string", () => {
    property(S.string)
  })

  it("number", () => {
    property(S.number)
  })

  it("unknown", () => {
    property(S.unknown)
  })

  it("struct/ prop", () => {
    property(S.struct({
      a: S.string
    }))
  })

  it("struct/ symbol prop", () => {
    const a = Symbol.for("@effect/schema/test/a")
    property(
      S.struct({
        [a]: S.string
      })
    )
  })

  it("struct/ optional prop", () => {
    property(S.struct({
      a: S.optional(S.string)
    }))
  })

  it("struct/ prop + prop", () => {
    property(S.struct({
      a: S.string,
      b: S.number
    }))
  })

  it("struct/ prop + optional prop", () => {
    property(S.struct({
      a: S.string,
      b: S.optional(S.number)
    }))
  })

  it("record/ string", () => {
    const schema = S.record(S.string, S.string)
    const differ = fromSchema(schema)
    expect(differ({ a: "v" }, { a: "v" }).op).toStrictEqual(identical)
    expect(differ({ a: "v1" }, { a: "v2" }).op).toStrictEqual(
      objectOps([["a", replace("v1", "v2")]])
    )
    expect(differ({ a: "v" }, {}).op).toStrictEqual(objectOps([["a", remove("v")]]))
    expect(differ({}, { a: "v" }).op).toStrictEqual(objectOps([["a", add("v")]]))
    property(schema)
  })

  it("record/ symbol", () => {
    const a = Symbol.for("@effect/schema/test/a")
    const schema = S.record(S.symbol, S.string)
    const differ = fromSchema(schema)
    expect(differ({ [a]: "v" }, { [a]: "v" }).op).toStrictEqual(identical)
    expect(differ({ [a]: "v1" }, { [a]: "v2" }).op).toStrictEqual(
      objectOps([[a, replace("v1", "v2")]])
    )
    expect(differ({ [a]: "v" }, {}).op).toStrictEqual(objectOps([[a, remove("v")]]))
    expect(differ({}, { [a]: "v" }).op).toStrictEqual(objectOps([[a, add("v")]]))
    property(schema)
  })

  it("record/ string + symbol", () => {
    property(pipe(S.record(S.string, S.string), S.extend(S.record(S.symbol, S.string))))
  })

  it("refinement/ int", () => {
    property(pipe(S.number, S.int()))
  })

  // TODO: handle Maximum call stack size exceeded
  it.skip("lazy", () => {
    interface A {
      readonly a: string
      readonly as: ReadonlyArray<A>
    }
    const schema: S.Schema<A> = S.lazy(() =>
      S.struct({
        a: S.string,
        as: S.array(schema)
      })
    )
    property(schema)
  })

  it("lazy", () => {
    interface A {
      readonly a: string
      readonly as: ReadonlyArray<A>
    }
    const schema: S.Schema<A> = S.lazy(() =>
      S.struct({
        a: S.string,
        as: S.array(schema)
      })
    )
    const differ = fromSchema(schema)
    const patch = differ({ a: "a", as: [] }, { a: "b", as: [] })
    expect(patch.op).toStrictEqual(
      objectOps([["a", replace("a", "b")], ["as", replace([], [])]])
    )
  })

  it.skip("User", () => {
    const User_ = S.struct({
      age: pipe(S.number, S.int()),
      dateOfBirth: S.optional(S.dateFromString(S.string)),
      name: S.string,
      aliases: S.array(S.string)
    })

    type UserFrom = S.From<typeof User_> & { subUser?: UserFrom }
    type UserTo = S.To<typeof User_> & { subUser?: UserTo }
    const User: S.Schema<UserFrom, UserTo> = S.extend(User_)(S.struct({
      subUser: S.optional(S.lazy(() => User))
    }))
    const differ = fromSchema(User)
    const patch = differ({
      age: 0,
      name: "foo",
      aliases: [],
      subUser: {
        age: 20,
        name: "sub",
        aliases: []
      }
    }, {
      age: 0,
      name: "bar",
      aliases: [],
      subUser: {
        age: 10,
        name: "sub",
        aliases: []
      }
    })
    console.log("%o", patch.op)
  })
})

const expectJSONPatch = <I, A>(
  schema: S.Schema<I, A>,
  from: A,
  to: A,
  jsonPatch: Array<JSONPatch>
) => {
  const differ = fromSchema(schema)
  const patch = differ(from, to)
  const ejp = getJSONPatch(patch.op)
  if (Either.isRight(ejp)) {
    const jp = ejp.right
    expect(jp).toEqual(jsonPatch)
    const actual = jsonpatch.applyPatch(from, jp, undefined, false).newDocument
    expect(actual).toEqual(to)
  }
}

describe.concurrent("getJSONPatch", () => {
  it("number", () => {
    const schema = S.number
    expectJSONPatch(schema, 0, 1, [
      { op: "replace", path: "", value: 1 }
    ])
    expectJSONPatch(schema, 0, 0, [])
    expectJSONPatch(schema, 0, -0, [{ op: "replace", path: "", value: -0 }])
  })

  it("struct", () => {
    const schema = S.struct({
      a: S.string,
      b: S.number,
      c: S.struct({ d: S.boolean }),
      e: S.optional(S.string)
    })
    expectJSONPatch(schema, { a: "a", b: 1, c: { d: true } }, {
      a: "b",
      b: 2,
      c: { d: false },
      e: "e"
    }, [
      { op: "replace", path: "/a", value: "b" },
      {
        op: "replace",
        path: "/b",
        value: 2
      },
      { op: "add", path: "/e", value: "e" },
      { op: "replace", path: "/c/d", value: false }
    ])
  })

  it("record/ string", () => {
    const schema = S.record(S.string, S.string)
    expectJSONPatch(schema, {}, { "": "" }, [{ op: "add", path: "/", value: "" }])
    expectJSONPatch(schema, {}, { "/": "" }, [{ op: "add", path: "/~1", value: "" }])
  })
})
