import type { Scenario } from "../lib/scenario"
import { s1 } from "./s1-constraints"
import { s2 } from "./s2-conventions"
import { s3 } from "./s3-plan"
import { s4 } from "./s4-user-edit"
import { s5 } from "./s5-debugging"

export const scenarios: Scenario[] = [s1, s2, s3, s4, s5]
