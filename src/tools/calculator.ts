export function calculate(a: number, b: number, operation: string) {
  if (operation === "add") return a + b;
  if (operation === "subtract") return a - b;
  if (operation === "multiply") return a * b;
  if (operation === "divide") return a / b;

  return "Unknown operation";
}
