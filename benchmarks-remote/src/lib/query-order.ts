function numericId(queryId: string): number | undefined {
  const match = /\d+/.exec(queryId);
  return match ? Number.parseInt(match[0], 10) : undefined;
}

/** Orders numbered benchmark queries naturally and digit-less query IDs by name. */
export function compareQueryIds(left: string, right: string): number {
  const leftNumber = numericId(left);
  const rightNumber = numericId(right);

  if (leftNumber === undefined && rightNumber === undefined) {
    return left.localeCompare(right);
  }
  if (leftNumber === undefined) {
    return 1;
  }
  if (rightNumber === undefined) {
    return -1;
  }

  return leftNumber - rightNumber || left.localeCompare(right);
}
