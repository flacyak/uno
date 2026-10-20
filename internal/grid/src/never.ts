/**
 * unreachable is the default of a switch that handles every member of a
 * union. The compiler lets a value reach it only once nothing is left, so a
 * member added to the union is a type error at every switch missing a case
 * for it. At run time it throws, naming the value the types ruled out.
 */
export function unreachable(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
