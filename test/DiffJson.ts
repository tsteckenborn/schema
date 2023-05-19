import * as Chunk from "@effect/data/Chunk"
import * as Option from "@effect/data/Option"
import * as Diff from "@effect/schema/DiffJson"
import * as S from "@effect/schema/Schema"

const expectPatch = <I extends S.JsonObject | S.JsonArray, A>(
  schema: S.Schema<I, A>,
  from: A,
  to: A
) => {
  const differ = Diff.fromSchema(schema)
  const patch = differ.compare(from, to)
  // from -> to
  expect(Diff.applyPatch(patch)(from)).toEqual(to)
  // to -> from
  expect(Diff.applyPatch(Diff.inverse(patch))(to)).toEqual(from)
}

describe.concurrent("DiffJson", () => {
  it("struct/ number", () => {
    const schema = S.struct({ a: S.number })
    expectPatch(schema, { a: 1 }, { a: 2 })
  })

  it("struct/ Date", () => {
    const schema = S.struct({ a: S.Date })
    expectPatch(schema, { a: new Date(0) }, { a: new Date(1000) })
  })

  it("struct/ chunk(number)", () => {
    const schema = S.struct({ a: S.chunk(S.number) })
    expectPatch(schema, { a: Chunk.fromIterable([1, 2, 3]) }, { a: Chunk.fromIterable([1, 4, 3]) })
  })

  it("struct/ chunk(NumberFromString)", () => {
    const schema = S.struct({ a: S.chunk(S.NumberFromString) })
    expectPatch(schema, { a: Chunk.fromIterable([1, 2, 3]) }, { a: Chunk.fromIterable([1, 4, 3]) })
  })

  it("struct/ option(number)", () => {
    const schema = S.struct({ a: S.option(S.number) })
    expectPatch(schema, { a: Option.none() }, { a: Option.some(2) })
    expectPatch(schema, { a: Option.some(1) }, { a: Option.some(2) })
  })

  it("struct/ option(NumberFromString)", () => {
    const schema = S.struct({ a: S.option(S.NumberFromString) })
    expectPatch(schema, { a: Option.none() }, { a: Option.some(2) })
    expectPatch(schema, { a: Option.some(1) }, { a: Option.some(2) })
  })

  it("struct/ optionFromNullable(number)", () => {
    const schema = S.struct({ a: S.optionFromNullable(S.number) })
    expectPatch(schema, { a: Option.none() }, { a: Option.some(2) })
    expectPatch(schema, { a: Option.some(1) }, { a: Option.some(2) })
  })
})
