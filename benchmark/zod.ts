import { pipe } from "@effect/data/Function"
import type { ParseOptions } from "@effect/schema/AST"
// import * as D from "@effect/data/Debug"
import * as S from "@effect/schema/Schema"
import * as Benchmark from "benchmark"
import { z } from "zod"

/*
schema (good) x 565,170 ops/sec ±0.57% (96 runs sampled)
zod (good) x 654,070 ops/sec ±0.38% (99 runs sampled)
schema (bad) x 577,641 ops/sec ±0.15% (96 runs sampled)
zod (bad) x 149,704 ops/sec ±3.71% (92 runs sampled)
Fastest is zod (good)
*/

const suite = new Benchmark.Suite()

const UserZod = z.object({
  name: z.string().min(3).max(20),
  age: z.number().min(0).max(120),
  address: z.object({
    street: z.string().min(3).max(200),
    number: z.number().min(0).max(120),
    city: z.string().min(3).max(200),
    country: z.string().min(3).max(200),
    zip: z.string().min(3).max(200)
  })
}).strict()

const schema = S.struct({
  name: pipe(S.string, S.minLength(3), S.maxLength(20)),
  age: pipe(S.number, S.greaterThanOrEqualTo(0), S.lessThanOrEqualTo(120)),
  address: S.struct({
    street: pipe(S.string, S.minLength(3), S.maxLength(200)),
    number: pipe(S.number, S.greaterThanOrEqualTo(0), S.lessThanOrEqualTo(120)),
    city: pipe(S.string, S.minLength(3), S.maxLength(200)),
    country: pipe(S.string, S.minLength(3), S.maxLength(200)),
    zip: pipe(S.string, S.minLength(3), S.maxLength(200))
  })
})

const good = {
  name: "Joe",
  age: 13,
  address: {
    street: "Main Street",
    number: 12,
    city: "New York",
    country: "USA",
    zip: "12345"
  }
}

const bad = {
  name: "Jo",
  age: 13,
  address: {
    street: "Main Street",
    number: 12,
    city: "New York",
    country: "USA",
    zip: "12345"
  }
}

const parseEither = S.parseEither(schema)
const options: ParseOptions = { errors: "all" }

// console.log(UserZod.safeParse(good))
// console.log(parseEither(good))
// console.log(JSON.stringify(UserZod.safeParse(bad), null, 2))
// console.log(JSON.stringify(parseEither(bad), null, 2))

suite
  .add("schema (good)", function() {
    parseEither(good, options)
  })
  .add("zod (good)", function() {
    UserZod.safeParse(good)
  })
  .add("schema (bad)", function() {
    parseEither(bad, options)
  })
  .add("zod (bad)", function() {
    UserZod.safeParse(bad)
  })
  .on("cycle", function(event: any) {
    console.log(String(event.target))
  })
  .on("complete", function(this: any) {
    console.log("Fastest is " + this.filter("fastest").map("name"))
  })
  .run({ async: true })
