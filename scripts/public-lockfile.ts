/** Remove only the private infrastructure importer and package records from a pnpm v9 lockfile. */
export function publicLockfile(source: string): string {
  if (!source.startsWith("lockfileVersion: '9.0'\n"))
    throw new Error('Unsupported lockfile format');
  const lines = source.split('\n');
  const kept: string[] = [];
  let omit = false;
  let removed = 0;
  for (const line of lines) {
    // pnpm emits importer/package/snapshot records at two spaces. Their values are nested deeper.
    if (/^\S|^ {2}\S/.test(line)) {
      omit = /^  (?:infra:|'@inverternetwork\/platform-cdk@[^']+':)$/.test(line);
      if (omit) removed++;
    }
    if (!omit) kept.push(line);
  }
  if (removed < 3) throw new Error('Expected infra importer and platform-cdk package records');
  return kept.join('\n');
}
