import * as _ from "@fp-ts/schema/data/filter"
import * as P from "@fp-ts/schema/Parser"
import * as Pretty from "@fp-ts/schema/Pretty"
import * as S from "@fp-ts/schema/Schema"
import * as Util from "@fp-ts/schema/test/util"

describe.concurrent("nonNaN", () => {
  it("property tests", () => {
    Util.property(_.nonNaN(S.number))
  })

  it("Guard", () => {
    const is = P.is(_.nonNaN(S.number))
    expect(is(1)).toEqual(true)
    expect(is(NaN)).toEqual(false)
  })

  it("Decoder", () => {
    const schema = _.nonNaN(S.number)
    Util.expectDecodingSuccess(schema, 1)
    Util.expectDecodingFailure(schema, NaN, `Expected a number NaN excluded, actual NaN`)
  })

  it("Pretty", () => {
    const pretty = Pretty.pretty(_.nonNaN(S.number))
    expect(pretty(1)).toEqual("1")
    expect(pretty(NaN)).toEqual("NaN")
  })
})
