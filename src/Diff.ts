/**
 * @since 1.0.0
 */

import * as Either from "@effect/data/Either"
import * as ReadonlyArray from "@effect/data/ReadonlyArray"
import * as AST from "@effect/schema/AST"
import * as I from "@effect/schema/internal/common"
import * as S from "@effect/schema/Schema"

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

export type Op = Identical | Replace | ObjectOps | ArrayOps

export type NestedOp = Replace | Add | Remove | ObjectOps | ArrayOps

export interface Identical {
  readonly _tag: "Identical"
}

export const identical: Identical = ({ _tag: "Identical" })

const isIdentical = (op: Op): op is Identical => op._tag === "Identical"

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
  readonly ops: ReadonlyArray.NonEmptyReadonlyArray<[PropertyKey, NestedOp]>
}

export const objectOps = (ops: ObjectOps["ops"]): ObjectOps => ({
  _tag: "ObjectOps",
  ops
})

export interface ArrayOps {
  readonly _tag: "ArrayOps"
  readonly ops: ReadonlyArray.NonEmptyReadonlyArray<[number, NestedOp]>
}

export const arrayOps = (ops: ArrayOps["ops"]): ArrayOps => ({
  _tag: "ArrayOps",
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
    ReadonlyArray.mapNonEmpty(op.ops, ([key, op]) => [key, reverseNestedOp(op)])
  )

const reverseArrayOps = (op: ArrayOps): ArrayOps =>
  arrayOps(
    ReadonlyArray.mapNonEmpty(op.ops, ([key, op]) => [key, reverseNestedOp(op)])
  )

const reverseOp = (op: Op): Op => {
  switch (op._tag) {
    case "Identical":
      return op
    case "Replace":
      return reverseReplace(op)
    case "ObjectOps":
      return reverseObjectOps(op)
    case "ArrayOps":
      return reverseArrayOps(op)
  }
}

const reverseNestedOp = (op: NestedOp): NestedOp => {
  switch (op._tag) {
    case "Replace":
      return reverseReplace(op)
    case "Add":
      return remove(op.value)
    case "Remove":
      return add(op.value)
    case "ObjectOps":
      return reverseObjectOps(op)
    case "ArrayOps":
      return reverseArrayOps(op)
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
            case "ArrayOps":
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
      case "ArrayOps": {
        const out = a.slice()
        for (const [index, subop] of op.ops) {
          switch (subop._tag) {
            case "Replace":
            case "ObjectOps":
            case "ArrayOps":
              out[index] = runOp(subop)(a[index])
              break
            case "Add":
              out.splice(index, 0, subop.value)
              break
            case "Remove":
              out.splice(index, 1)
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
    case "Transform":
      return (from, to) => make((from === to) ? identical : replace(from, to))
    case "Refinement":
      return go(ast.from)
    case "Lazy":
      return go(ast.f())
    case "Tuple": {
      const elements = ast.elements.map((e) => go(e.type))
      return (from, to) => {
        const ops: Array<[number, NestedOp]> = []
        // ---------------------------------------------
        // handle elements
        // ---------------------------------------------
        for (let i = 0; i < elements.length; i++) {
          const differ = elements[i]
          const op = differ(from[i], to[i]).op
          if (!isIdentical(op)) {
            ops.push([i, op])
          }
        }
        return make(ReadonlyArray.isNonEmptyReadonlyArray(ops) ? arrayOps(ops) : identical)
      }
    }
    case "TypeLiteral": {
      const propertySignatures = ast.propertySignatures.map((ps) => go(ps.type))
      const indexSignatures = ast.indexSignatures.map((is) => go(is.type))
      const expectedKeys: any = {}
      for (let i = 0; i < propertySignatures.length; i++) {
        expectedKeys[ast.propertySignatures[i].name] = null
      }
      return (from, to) => {
        const ops: Array<[PropertyKey, NestedOp]> = []
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

export type JSONPatch =
  | { readonly op: "add"; readonly path: string; readonly value: S.Json }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "replace"; readonly path: string; readonly value: S.Json }

const pointer = (path: Array<string>): string =>
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

// STATUS: experimental (Not thoroughly tested)
export const getJSONPatch = Either.liftThrowable((op: Op): Array<JSONPatch> => {
  const out: Array<JSONPatch> = []
  const path: Array<string> = []

  const replace = (to: unknown) =>
    out.push({ op: "replace", path: pointer(path), value: validateJson(to) })

  const add = (value: unknown) =>
    out.push({ op: "add", path: pointer(path), value: validateJson(value) })

  const remove = () => out.push({ op: "remove", path: pointer(path) })

  const objectOps = (op: ObjectOps) => {
    op.ops.forEach(([key, op]) => {
      path.push(validateString(key))
      switch (op._tag) {
        case "Replace":
          replace(op.to)
          break
        case "Add":
          add(op.value)
          break
        case "Remove":
          remove()
          break
        case "ObjectOps":
          objectOps(op)
          break
        case "ArrayOps":
          arrayOps(op)
          break
      }
      path.pop()
    })
  }

  const arrayOps = (op: ArrayOps) => {
    op.ops.forEach(([key, op]) => {
      path.push(String(key))
      switch (op._tag) {
        case "Replace":
          replace(op.to)
          break
        case "Add":
          add(op.value)
          break
        case "Remove":
          remove()
          break
        case "ObjectOps":
          objectOps(op)
          break
        case "ArrayOps":
          arrayOps(op)
          break
      }
      path.pop()
    })
  }
  switch (op._tag) {
    case "Identical":
      break
    case "Replace":
      replace(op.to)
      break
    case "ObjectOps":
      objectOps(op)
      break
    case "ArrayOps":
      arrayOps(op)
      break
  }
  return out
}, (e) => e instanceof Error ? e : new Error(String(e)))
