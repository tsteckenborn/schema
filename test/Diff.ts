import * as Either from "@effect/data/Either"
import { pipe } from "@effect/data/Function"
import * as A from "@effect/schema/Arbitrary"
import * as Diff from "@effect/schema/Diff"
import * as S from "@effect/schema/Schema"
import * as fc from "fast-check"
import * as jsonpatch from "fast-json-patch"

const debug = false

const isJson = (a: unknown): a is S.Json =>
  Either.isRight(S.validateEither(S.json)(a, { onExcessProperty: "error" }))

const property = <I, A>(schema: S.Schema<I, A>) => {
  const differ = Diff.fromSchema(schema)
  const arb = A.to(schema)(fc)
  if (debug) {
    const [from, to] = fc.sample(arb, 2)
    const patch = differ(from, to)
    console.log("%o", patch)
  }
  fc.assert(fc.property(arb, arb, (from, to) => {
    // test identical
    expect(differ(from, from).op).toEqual(Diff.identical)
    // test non identical
    const patch = differ(from, to)
    // test run patch
    expect(Diff.runPatch(patch)(from)).toEqual(to)
    expect(Diff.runPatch(Diff.reverse(patch))(to)).toEqual(from)
    // test jsonPatch
    const jp = Diff.getJSONPatch(patch.op)
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
    const differ = Diff.fromSchema(S.number)
    const patch = differ(NaN, 0)
    expect(patch.op).toStrictEqual(Diff.replace(NaN, 0))
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

  it("refinement/ int", () => {
    property(pipe(S.number, S.int()))
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
    const differ = Diff.fromSchema(schema)
    expect(differ({ a: "v" }, { a: "v" }).op).toStrictEqual(Diff.identical)
    expect(differ({ a: "v1" }, { a: "v2" }).op).toStrictEqual(
      Diff.objectOps([["a", Diff.replace("v1", "v2")]])
    )
    expect(differ({ a: "v" }, {}).op).toStrictEqual(Diff.objectOps([["a", Diff.remove("v")]]))
    expect(differ({}, { a: "v" }).op).toStrictEqual(Diff.objectOps([["a", Diff.add("v")]]))
    property(schema)
  })

  it("record/ symbol", () => {
    const a = Symbol.for("@effect/schema/test/a")
    const schema = S.record(S.symbol, S.string)
    const differ = Diff.fromSchema(schema)
    expect(differ({ [a]: "v" }, { [a]: "v" }).op).toStrictEqual(Diff.identical)
    expect(differ({ [a]: "v1" }, { [a]: "v2" }).op).toStrictEqual(
      Diff.objectOps([[a, Diff.replace("v1", "v2")]])
    )
    expect(differ({ [a]: "v" }, {}).op).toStrictEqual(Diff.objectOps([[a, Diff.remove("v")]]))
    expect(differ({}, { [a]: "v" }).op).toStrictEqual(Diff.objectOps([[a, Diff.add("v")]]))
    property(schema)
  })

  it("record/ string + symbol", () => {
    property(pipe(S.record(S.string, S.string), S.extend(S.record(S.symbol, S.string))))
  })

  it("tuple/ 0 elements", () => {
    property(S.tuple())
  })

  it("tuple/ 1 element", () => {
    property(S.tuple(S.string))
  })

  it("tuple/ 2 elements", () => {
    property(S.tuple(S.string, S.number))
  })

  // TODO: handle Maximum call stack size exceeded
  it.skip("lazy (arb)", () => {
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

  it.only("lazy (manual)", () => {
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
    const differ = Diff.fromSchema(schema)
    const patch = differ({ a: "a", as: [] }, { a: "b", as: [] })
    expect(patch.op).toStrictEqual(
      Diff.objectOps([["a", Diff.replace("a", "b")]])
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
    const differ = Diff.fromSchema(User)
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
  jsonPatch: Array<Diff.JSONPatch>
) => {
  const differ = Diff.fromSchema(schema)
  const patch = differ(from, to)
  const ejp = Diff.getJSONPatch(patch.op)
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

  it("tuple", () => {
    const schema = S.tuple(S.string, S.number)
    expectJSONPatch(schema, ["a", 1], ["b", 2], [
      { op: "replace", path: "/0", value: "b" },
      { op: "replace", path: "/1", value: 2 }
    ])
  })
})
