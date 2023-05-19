/**
 * @since 1.0.0
 */

import * as S from "@effect/schema/Schema"
import * as jsonpatch from "fast-json-patch"

export interface Differ<A> {
  readonly schema: S.Schema<any, A>
  readonly compare: (from: A, to: A) => Patch<A>
}

export interface Patch<A> {
  readonly schema: S.Schema<any, A>
  readonly patch: ReadonlyArray<jsonpatch.Operation>
  readonly inverse: ReadonlyArray<jsonpatch.Operation>
}

export const inverse = <A>(patch: Patch<A>): Patch<A> => ({
  schema: patch.schema,
  patch: patch.inverse,
  inverse: patch.patch
})

export const fromSchema = <I extends S.JsonObject | S.JsonArray, A>(
  schema: S.Schema<I, A>
): Differ<A> => {
  const encode = S.encode(schema)
  return {
    schema,
    compare: (from, to) => {
      const ifrom = encode(from)
      const ito = encode(to)
      return ({
        schema,
        patch: jsonpatch.compare(ifrom, ito),
        inverse: jsonpatch.compare(ito, ifrom)
      })
    }
  }
}

export const applyPatch = <A>(patch: Patch<A>) => {
  const decode = S.decode(patch.schema)
  const encode = S.encode(patch.schema)
  return (a: A): A =>
    decode(jsonpatch.applyPatch(encode(a), patch.patch, undefined, false).newDocument)
}
