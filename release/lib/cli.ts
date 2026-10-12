// Minimal flag parsing shared by the release tools.
/** `--name value` (first occurrence). */
export function arg(name: string, argv = process.argv): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
/** Every value of a repeatable `--name value` flag. */
export function args(name: string, argv = process.argv): string[] {
  return argv.flatMap((a, i) => (argv[i - 1] === name ? [a] : []));
}
