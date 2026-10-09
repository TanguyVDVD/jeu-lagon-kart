/** Bound rendering detail, not authored dimensions. */
export function roadMeshRows(length: number, metresPerSegment = 2): number {
  return Math.max(2, Math.min(4096, Math.ceil(length / metresPerSegment)));
}
