const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Return the canonical allow-list after toggling one exact Android package.
 * Kept independent of NativeScript so the interaction contract is executable
 * in host tests rather than being inferred from XML event bindings.
 */
export function toggleAllowedNotificationPackage(
  currentPackages: readonly string[],
  packageName: string,
): string[] {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) return canonicalPackages(currentPackages);
  const selected = new Set(canonicalPackages(currentPackages));
  if (selected.has(packageName)) selected.delete(packageName);
  else selected.add(packageName);
  return Array.from(selected).sort();
}

function canonicalPackages(packages: readonly string[]): string[] {
  return Array.from(new Set(packages.filter((item) => PACKAGE_NAME_PATTERN.test(item)))).sort();
}
