import { Fixed } from "@changesets/types";
import { Package } from "@manypkg/get-packages";
import { InternalRelease } from "./types";
import { getCurrentHighestVersion, getHighestReleaseType } from "./utils";

export default function matchFixedConstraint(
  releases: Map<string, InternalRelease>,
  packagesByName: Map<string, Package>,
  fixed: Fixed
): boolean {
  let updated = false;

  for (let fixedPackages of fixed) {
    let releasingFixedPackages = [...releases.values()].filter(
      release => fixedPackages.includes(release.name) && release.type !== "none"
    );

    if (releasingFixedPackages.length === 0) continue;

    let highestReleaseType = getHighestReleaseType(releasingFixedPackages);
    let highestVersion = getCurrentHighestVersion(
      fixedPackages,
      packagesByName
    );

    // Finally, we update the packages so all of them are on the highest version
    for (let pkgName of fixedPackages) {
      let release = releases.get(pkgName);

      if (!release) {
        updated = true;
        releases.set(pkgName, {
          name: pkgName,
          type: highestReleaseType,
          oldVersion: highestVersion,
          changesets: []
        });
        continue;
      }

      if (release.type !== highestReleaseType) {
        updated = true;
        release.type = highestReleaseType;
      }
      if (release.oldVersion !== highestVersion) {
        updated = true;
        release.oldVersion = highestVersion;
      }
    }
  }

  return updated;
}
