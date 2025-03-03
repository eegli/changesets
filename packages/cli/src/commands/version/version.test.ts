import fixtures from "fixturez";

import fs from "fs-extra";
import path from "path";
import * as git from "@changesets/git";
import { warn } from "@changesets/logger";
import { silenceLogsInBlock } from "@changesets/test-utils";
import writeChangeset from "@changesets/write";
import { NewChangeset, Config } from "@changesets/types";
import { defaultConfig } from "@changesets/config";
import { getPackages } from "@manypkg/get-packages";
import pre from "../pre";
import version from "./index";
import humanId from "human-id";

const f = fixtures(__dirname);

let changelogPath = path.resolve(__dirname, "../../changelog");
let modifiedDefaultConfig: Config = {
  ...defaultConfig,
  changelog: [changelogPath, null]
};

let defaultOptions = {
  snapshot: undefined
};

// avoid polluting test logs with error message in console
// This is from bolt's error log
const consoleError = console.error;

jest.mock("../../utils/cli-utilities");
jest.mock("@changesets/git");
jest.mock("human-id");
jest.mock("@changesets/logger");

// @ts-ignore
git.add.mockImplementation(() => Promise.resolve(true));
// @ts-ignore
git.commit.mockImplementation(() => Promise.resolve(true));
// @ts-ignore
git.getCommitsThatAddFiles.mockImplementation(changesetIds =>
  Promise.resolve(changesetIds.map(() => "g1th4sh"))
);
// @ts-ignore
git.tag.mockImplementation(() => Promise.resolve(true));

const simpleChangeset: NewChangeset = {
  summary: "This is a summary",
  releases: [{ name: "pkg-a", type: "minor" }],
  id: "having-lotsof-fun"
};

const simpleChangeset2: NewChangeset = {
  summary: "This is a summary too",
  releases: [
    { name: "pkg-a", type: "minor" },
    { name: "pkg-b", type: "patch" }
  ],
  id: "wouldnit-be-nice"
};

const simpleChangeset3: NewChangeset = {
  summary: "This is not a summary",
  releases: [{ name: "pkg-b", type: "patch" }],
  id: "hot-day-today"
};

const writeChangesets = (changesets: NewChangeset[], cwd: string) => {
  return Promise.all(
    changesets.map(changeset => writeChangeset(changeset, cwd))
  );
};

const getFile = (pkgName: string, fileName: string, calls: any) => {
  let castCalls: [string, string][] = calls;
  const foundCall = castCalls.find(call =>
    call[0].endsWith(`${pkgName}${path.sep}${fileName}`)
  );
  if (!foundCall)
    throw new Error(`could not find writing of ${fileName} for: ${pkgName}`);

  // return written content
  return foundCall[1];
};

const getPkgJSON = (pkgName: string, calls: any) => {
  return JSON.parse(getFile(pkgName, "package.json", calls));
};

const getChangelog = (pkgName: string, calls: any) => {
  return getFile(pkgName, "CHANGELOG.md", calls);
};

const writeEmptyChangeset = (cwd: string) => writeChangesets([], cwd);

beforeEach(() => {
  let i = 0;
  (humanId as jest.Mock<string, []>).mockImplementation(() => {
    return `some-id-${i++}`;
  });

  console.error = jest.fn();
});

afterEach(() => {
  console.error = consoleError;
});

describe("running version in a simple project", () => {
  silenceLogsInBlock();
  let cwd: string;

  beforeEach(async () => {
    cwd = await f.copy("simple-project");
    console.error = jest.fn();
  });

  afterEach(async () => {
    console.error = consoleError;
  });

  describe("when there are no changeset commits", () => {
    it("should warn if no changeset commits exist", async () => {
      await writeEmptyChangeset(cwd);
      await version(cwd, defaultOptions, modifiedDefaultConfig);
      // @ts-ignore
      const loggerWarnCalls = warn.mock.calls;
      expect(loggerWarnCalls.length).toEqual(1);
      expect(loggerWarnCalls[0][0]).toEqual(
        "No unreleased changesets found, exiting."
      );
    });
  });

  describe("when there is a changeset commit", () => {
    it("should bump releasedPackages", async () => {
      await writeChangesets([simpleChangeset2], cwd);
      const spy = jest.spyOn(fs, "writeFile");

      await version(cwd, defaultOptions, modifiedDefaultConfig);

      expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
        expect.objectContaining({ name: "pkg-a", version: "1.1.0" })
      );
      expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
        expect.objectContaining({ name: "pkg-b", version: "1.0.1" })
      );
    });
  });

  it("should not touch package.json of an ignored package when it is not a dependent of any releasedPackages ", async () => {
    await writeChangesets([simpleChangeset], cwd);
    const spy = jest.spyOn(fs, "writeFile");

    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      ignore: ["pkg-a"]
    });

    const bumpedPackageA = !!spy.mock.calls.find((call: string[]) =>
      call[0].endsWith(`pkg-a${path.sep}package.json`)
    );

    expect(bumpedPackageA).toBe(false);
  });

  it("should not bump ignored packages", async () => {
    await writeChangesets([simpleChangeset, simpleChangeset3], cwd);

    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      ignore: ["pkg-a"]
    });

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "1.0.1",
          },
          "name": "pkg-a",
          "version": "1.0.0",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.1",
        },
      ]
    `);
  });

  it("should not commit the result if commit config is not set", async () => {
    await writeChangesets([simpleChangeset2], cwd);
    const spy = jest.spyOn(git, "commit");

    expect(spy).not.toHaveBeenCalled();

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect(spy).not.toHaveBeenCalled();
  });

  it("should commit the result if commit config is set", async () => {
    await writeChangesets([simpleChangeset2], cwd);
    const spy = jest.spyOn(git, "commit");

    expect(spy).not.toHaveBeenCalled();

    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      commit: true
    });

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toMatchInlineSnapshot(`
      "RELEASING: Releasing 2 package(s)

      Releases:
        pkg-a@1.1.0
        pkg-b@1.0.1

      [skip ci]
      "
    `);
  });

  it("should skip over ignored changesets", async () => {
    const cwd = await f.copy("ignored-changeset");

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    let packages = await getPackages(cwd);
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        name: "pkg-a",
        version: "1.1.0",
        dependencies: {
          "pkg-b": "1.0.0"
        }
      },
      {
        name: "pkg-b",
        version: "1.0.0"
      }
    ]);

    const changesetDir = await fs.readdir(path.join(cwd, ".changeset"));
    // should still contain the ignored changeset
    expect(changesetDir).toContain(".ignored-temporarily.md");
  });

  it("should not update a dependant that uses a tag as a dependency rage for a package that could otherwise be local", async () => {
    const cwd = await f.copy("dependant-with-tag-range");

    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "major" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-a": "latest",
          },
          "name": "example-a",
          "version": "1.0.0",
        },
        Object {
          "name": "pkg-a",
          "version": "2.0.0",
        },
      ]
    `);
  });

  describe("when there are multiple changeset commits", () => {
    it("should bump releasedPackages", async () => {
      await writeChangesets([simpleChangeset, simpleChangeset2], cwd);
      const spy = jest.spyOn(fs, "writeFile");

      await version(cwd, defaultOptions, modifiedDefaultConfig);

      expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
        expect.objectContaining({ name: "pkg-a", version: "1.1.0" })
      );
      expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
        expect.objectContaining({ name: "pkg-b", version: "1.0.1" })
      );
    });

    it("should bump multiple released packages if required", async () => {
      await writeChangesets([simpleChangeset, simpleChangeset2], cwd);
      const spy = jest.spyOn(fs, "writeFile");
      await version(cwd, defaultOptions, modifiedDefaultConfig);

      // first call should be minor bump
      expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
        expect.objectContaining({
          name: "pkg-a",
          version: "1.1.0"
        })
      );
      // second should be a patch
      expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
        expect.objectContaining({
          name: "pkg-b",
          version: "1.0.1"
        })
      );
    });
    it("should delete the changeset files", async () => {
      await writeChangesets([simpleChangeset, simpleChangeset2], cwd);
      await version(cwd, defaultOptions, modifiedDefaultConfig);

      const files = await fs.readdir(path.resolve(cwd, ".changeset"));
      expect(files.length).toBe(2);
    });
  });
});

describe("fixed", () => {
  it("should bump packages to the correct versions when packages are fixed", async () => {
    const cwd = await f.copy("fixed-packages");
    await writeChangesets([simpleChangeset], cwd);
    const spy = jest.spyOn(fs, "writeFile");

    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      fixed: [["pkg-a", "pkg-b"]]
    });

    expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
      expect.objectContaining({ name: "pkg-a", version: "1.1.0" })
    );
    expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
      expect.objectContaining({ name: "pkg-b", version: "1.1.0" })
    );
  });

  it("should update CHANGELOGs of all packages from the fixed group", async () => {
    const cwd = await f.copy("fixed-packages");
    const spy = jest.spyOn(fs, "writeFile");

    await writeChangesets([simpleChangeset], cwd);

    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      fixed: [["pkg-a", "pkg-b"]]
    });

    expect(getChangelog("pkg-a", spy.mock.calls)).toMatchInlineSnapshot(`
      "# pkg-a

      ## 1.1.0

      ### Minor Changes

      - g1th4sh: This is a summary

      ### Patch Changes

      - pkg-b@1.1.0
      "
    `);
    expect(getChangelog("pkg-b", spy.mock.calls)).toMatchInlineSnapshot(`
      "# pkg-b

      ## 1.1.0
      "
    `);

    spy.mockClear();

    await writeChangesets([simpleChangeset], cwd);

    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      fixed: [["pkg-a", "pkg-b"]]
    });

    expect(getChangelog("pkg-a", spy.mock.calls)).toMatchInlineSnapshot(`
      "# pkg-a

      ## 1.2.0

      ### Minor Changes

      - g1th4sh: This is a summary

      ### Patch Changes

      - pkg-b@1.2.0

      ## 1.1.0

      ### Minor Changes

      - g1th4sh: This is a summary

      ### Patch Changes

      - pkg-b@1.1.0
      "
    `);
    expect(getChangelog("pkg-b", spy.mock.calls)).toMatchInlineSnapshot(`
      "# pkg-b

      ## 1.2.0

      ## 1.1.0
      "
    `);
  });
});

describe("linked", () => {
  it("should bump packages to the correct versions when packages are linked", async () => {
    const cwd = await f.copy("linked-packages");
    await writeChangesets([simpleChangeset2], cwd);
    const spy = jest.spyOn(fs, "writeFile");

    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      linked: [["pkg-a", "pkg-b"]]
    });

    expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
      expect.objectContaining({ name: "pkg-a", version: "1.1.0" })
    );
    expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
      expect.objectContaining({ name: "pkg-b", version: "1.1.0" })
    );
  });

  it("should not break when there is a linked package without a changeset", async () => {
    const cwd = await f.copy("linked-packages");
    await writeChangesets([simpleChangeset], cwd);
    const spy = jest.spyOn(fs, "writeFile");

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
      expect.objectContaining({ name: "pkg-a", version: "1.1.0" })
    );
  });
});

describe("workspace range", () => {
  it("should update dependency range correctly", async () => {
    const cwd = f.copy("simple-workspace-range-dep");

    await writeChangesets([simpleChangeset2], cwd);
    await version(cwd, defaultOptions, modifiedDefaultConfig);

    let packages = await getPackages(cwd);
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        name: "pkg-a",
        version: "1.1.0",
        dependencies: {
          "pkg-b": "workspace:1.0.1"
        }
      },
      {
        name: "pkg-b",
        version: "1.0.1"
      }
    ]);
  });

  it("should bump dependent package when bumping a `workspace:*` dependency", async () => {
    const cwd = f.copy("simple-workspace-wildcard-range-dep");

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);

    let packages = await getPackages(cwd);
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        name: "pkg-a",
        version: "1.0.1",
        dependencies: {
          "pkg-b": "workspace:*"
        }
      },
      {
        name: "pkg-b",
        version: "1.0.1"
      }
    ]);
  });

  it("should bump dependent package when bumping a `workspace:^` dependency", async () => {
    const cwd = f.copy("workspace-alias-range-dep");

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);

    let packages = await getPackages(cwd);
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        name: "pkg-a",
        version: "1.0.1",
        dependencies: {
          "pkg-b": "workspace:^",
          "pkg-c": "workspace:~"
        }
      },
      {
        name: "pkg-b",
        version: "1.0.1"
      },
      {
        name: "pkg-c",
        version: "1.0.0"
      }
    ]);
  });
});

describe("same package in different dependency types", () => {
  it("should update different range types correctly", async () => {
    let cwd = f.copy("simple-project-same-dep-diff-range");
    await writeChangeset(
      {
        releases: [
          {
            name: "pkg-b",
            type: "patch"
          }
        ],
        summary: "a very useful summary for the first change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    let packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        devDependencies: {
          "pkg-b": "1.0.1"
        },
        peerDependencies: {
          "pkg-b": "^1.0.1"
        },
        name: "pkg-a",
        version: "1.0.0"
      },
      {
        name: "pkg-b",
        version: "1.0.1"
      }
    ]);
  });
});

describe("snapshot release", () => {
  it("should update the package to unique version no matter the kind of version bump it is", async () => {
    let cwd = f.copy("simple-project");
    await writeChangesets([simpleChangeset2], cwd);
    const spy = jest.spyOn(fs, "writeFile");
    await version(
      cwd,
      {
        snapshot: "experimental"
      },
      {
        ...modifiedDefaultConfig,
        commit: false
      }
    );
    expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
      expect.objectContaining({
        name: "pkg-a",
        version: expect.stringContaining("0.0.0-experimental-")
      })
    );

    expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
      expect.objectContaining({
        name: "pkg-b",
        version: expect.stringContaining("0.0.0-experimental-")
      })
    );
  });

  it("should not commit the result even if commit config is set", async () => {
    let cwd = f.copy("simple-project");
    await writeChangesets([simpleChangeset2], cwd);
    const spy = jest.spyOn(git, "commit");

    expect(spy).not.toHaveBeenCalled();

    await version(
      cwd,
      {
        snapshot: "experimental"
      },
      {
        ...modifiedDefaultConfig,
        commit: true
      }
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it("should not bump version of a package with an explicit none release type", async () => {
    const cwd = await f.copy("simple-project");
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "none" }],
        summary: "some internal stuff"
      },
      cwd
    );

    await version(
      cwd,
      {
        snapshot: true
      },
      modifiedDefaultConfig
    );

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "1.0.0",
          },
          "name": "pkg-a",
          "version": "1.0.0",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.0",
        },
      ]
    `);
  });

  it("should not bump version of an ignored package when its dependency gets updated", async () => {
    const originalDate = Date;
    // eslint-disable-next-line no-global-assign
    Date = class Date {
      toISOString() {
        return "2021-12-13T00:07:30.879Z";
      }
    } as any;
    try {
      const cwd = await f.copy("simple-project");
      await writeChangeset(
        {
          releases: [{ name: "pkg-b", type: "major" }],
          summary: "a very useful summary"
        },
        cwd
      );

      await version(
        cwd,
        {
          snapshot: true
        },
        {
          ...modifiedDefaultConfig,
          ignore: ["pkg-a"]
        }
      );

      expect((await getPackages(cwd)).packages.map(x => x.packageJson))
        .toMatchInlineSnapshot(`
        Array [
          Object {
            "dependencies": Object {
              "pkg-b": "0.0.0-20211213000730",
            },
            "name": "pkg-a",
            "version": "1.0.0",
          },
          Object {
            "name": "pkg-b",
            "version": "0.0.0-20211213000730",
          },
        ]
      `);
    } finally {
      // eslint-disable-next-line no-global-assign
      Date = originalDate;
    }
  });

  describe("useCalculatedVersionForSnapshots: true", () => {
    it("should update packages using calculated version", async () => {
      let cwd = f.copy("simple-project");
      await writeChangesets([simpleChangeset2], cwd);
      const spy = jest.spyOn(fs, "writeFile");
      await version(
        cwd,
        {
          snapshot: "experimental"
        },
        {
          ...modifiedDefaultConfig,
          commit: false,
          ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: {
            ...modifiedDefaultConfig.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH,
            useCalculatedVersionForSnapshots: true
          }
        }
      );
      expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
        expect.objectContaining({
          name: "pkg-a",
          version: expect.stringContaining("1.1.0-experimental-")
        })
      );

      expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
        expect.objectContaining({
          name: "pkg-b",
          version: expect.stringContaining("1.0.1-experimental-")
        })
      );
    });

    it("should not bump version of a package with an explicit none release type", async () => {
      const cwd = await f.copy("simple-project");
      await writeChangeset(
        {
          releases: [{ name: "pkg-a", type: "none" }],
          summary: "some internal stuff"
        },
        cwd
      );

      await version(
        cwd,
        {
          snapshot: true
        },
        {
          ...modifiedDefaultConfig,
          ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: {
            ...modifiedDefaultConfig.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH,
            useCalculatedVersionForSnapshots: true
          }
        }
      );

      expect((await getPackages(cwd)).packages.map(x => x.packageJson))
        .toMatchInlineSnapshot(`
        Array [
          Object {
            "dependencies": Object {
              "pkg-b": "1.0.0",
            },
            "name": "pkg-a",
            "version": "1.0.0",
          },
          Object {
            "name": "pkg-b",
            "version": "1.0.0",
          },
        ]
      `);
    });

    it("should not bump version of an ignored package when its dependency gets updated", async () => {
      const originalDate = Date;
      // eslint-disable-next-line no-global-assign
      Date = class Date {
        toISOString() {
          return "2021-12-13T00:07:30.879Z";
        }
      } as any;
      try {
        const cwd = await f.copy("simple-project");
        await writeChangeset(
          {
            releases: [{ name: "pkg-b", type: "major" }],
            summary: "a very useful summary"
          },
          cwd
        );

        await version(
          cwd,
          {
            snapshot: true
          },
          {
            ...modifiedDefaultConfig,
            ignore: ["pkg-a"],
            ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: {
              ...modifiedDefaultConfig.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH,
              useCalculatedVersionForSnapshots: true
            }
          }
        );

        expect((await getPackages(cwd)).packages.map(x => x.packageJson))
          .toMatchInlineSnapshot(`
          Array [
            Object {
              "dependencies": Object {
                "pkg-b": "2.0.0-20211213000730",
              },
              "name": "pkg-a",
              "version": "1.0.0",
            },
            Object {
              "name": "pkg-b",
              "version": "2.0.0-20211213000730",
            },
          ]
        `);
      } finally {
        // eslint-disable-next-line no-global-assign
        Date = originalDate;
      }
    });
  });
});

describe("updateInternalDependents: always", () => {
  it("should bump a direct dependent when a dependency package gets bumped", async () => {
    const cwd = await f.copy("simple-project-caret-dep");
    const spy = jest.spyOn(fs, "writeFile");
    await writeChangeset(simpleChangeset3, cwd);
    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: {
        ...defaultConfig.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH,
        updateInternalDependents: "always"
      }
    });

    expect(getPkgJSON("pkg-a", spy.mock.calls)).toEqual(
      expect.objectContaining({
        name: "pkg-a",
        version: "1.0.1",
        dependencies: {
          "pkg-b": "^1.0.1"
        }
      })
    );
    expect(getPkgJSON("pkg-b", spy.mock.calls)).toEqual(
      expect.objectContaining({
        name: "pkg-b",
        version: "1.0.1"
      })
    );
    expect(getChangelog("pkg-a", spy.mock.calls)).toMatchInlineSnapshot(`
      "# pkg-a

      ## 1.0.1

      ### Patch Changes

      - Updated dependencies [g1th4sh]
        - pkg-b@1.0.1
      "
    `);
    expect(getChangelog("pkg-b", spy.mock.calls)).toMatchInlineSnapshot(`
      "# pkg-b

      ## 1.0.1

      ### Patch Changes

      - g1th4sh: This is not a summary
      "
    `);
  });
});

describe("pre", () => {
  it("should work", async () => {
    let cwd = f.copy("simple-project");
    await pre(cwd, { command: "enter", tag: "next" });
    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    let packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "1.0.1-next.0"
        },
        name: "pkg-a",
        version: "1.0.1-next.0"
      },
      {
        name: "pkg-b",
        version: "1.0.1-next.0"
      }
    ]);
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "patch" }],
        summary: "a very useful summary"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "1.0.1-next.0"
        },
        name: "pkg-a",
        version: "1.0.1-next.1"
      },
      {
        name: "pkg-b",
        version: "1.0.1-next.0"
      }
    ]);
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "patch" }],
        summary: "a very useful summary for the second change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "1.0.1-next.0"
        },
        name: "pkg-a",
        version: "1.0.1-next.2"
      },
      {
        name: "pkg-b",
        version: "1.0.1-next.0"
      }
    ]);
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "minor" }],
        summary: "a very useful summary for the third change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toMatchInlineSnapshot(
      [
        {
          dependencies: {
            "pkg-b": "1.0.1-next.0"
          },
          name: "pkg-a",
          version: "1.1.0-next.3"
        },
        {
          name: "pkg-b",
          version: "1.0.1-next.0"
        }
      ],
      `
      Object {
        "0": Object {
          "dependencies": Object {
            "pkg-b": "1.0.1-next.0",
          },
          "name": "pkg-a",
          "version": "1.1.0-next.3",
        },
        "1": Object {
          "name": "pkg-b",
          "version": "1.0.1-next.0",
        },
      }
    `
    );
    await pre(cwd, { command: "exit" });
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "1.0.1"
        },
        name: "pkg-a",
        version: "1.1.0"
      },
      {
        name: "pkg-b",
        version: "1.0.1"
      }
    ]);
    expect(
      await fs.readFile(
        path.join(packages.packages[0].dir, "CHANGELOG.md"),
        "utf8"
      )
    ).toMatchInlineSnapshot(`
      "# pkg-a

      ## 1.1.0

      ### Minor Changes

      - g1th4sh: a very useful summary for the third change

      ### Patch Changes

      - g1th4sh: a very useful summary
      - g1th4sh: a very useful summary for the second change
      - Updated dependencies [g1th4sh]
        - pkg-b@1.0.1

      ## 1.1.0-next.3

      ### Minor Changes

      - g1th4sh: a very useful summary for the third change

      ## 1.0.1-next.2

      ### Patch Changes

      - g1th4sh: a very useful summary for the second change

      ## 1.0.1-next.1

      ### Patch Changes

      - g1th4sh: a very useful summary

      ## 1.0.1-next.0

      ### Patch Changes

      - Updated dependencies [g1th4sh]
        - pkg-b@1.0.1-next.0
      "
    `);
    expect(
      await fs.readFile(
        path.join(packages.packages[1].dir, "CHANGELOG.md"),
        "utf8"
      )
    ).toMatchInlineSnapshot(`
      "# pkg-b

      ## 1.0.1

      ### Patch Changes

      - g1th4sh: a very useful summary for the first change

      ## 1.0.1-next.0

      ### Patch Changes

      - g1th4sh: a very useful summary for the first change
      "
    `);
  });
  it("should work with adding a package while in pre mode", async () => {
    let cwd = f.copy("simple-project");
    await pre(cwd, { command: "enter", tag: "next" });
    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);
    let packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "1.0.1-next.0"
        },
        name: "pkg-a",
        version: "1.0.1-next.0"
      },
      {
        name: "pkg-b",
        version: "1.0.1-next.0"
      }
    ]);
    await fs.mkdir(path.join(cwd, "packages", "pkg-c"));
    await fs.writeJson(path.join(cwd, "packages", "pkg-c", "package.json"), {
      name: "pkg-c",
      version: "0.0.0"
    });
    await writeChangeset(
      {
        releases: [
          { name: "pkg-b", type: "major" },
          { name: "pkg-c", type: "patch" }
        ],
        summary: "a very useful summary for the first change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "2.0.0-next.1"
        },
        name: "pkg-a",
        version: "1.0.1-next.1"
      },
      {
        name: "pkg-b",
        version: "2.0.0-next.1"
      },
      {
        name: "pkg-c",
        version: "0.0.1-next.0"
      }
    ]);
  });
  it("should work for my weird case", async () => {
    let cwd = f.copy("simple-project");
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "minor" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    let packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: { "pkg-b": "1.0.0" },
        name: "pkg-a",
        version: "1.1.0"
      },
      {
        name: "pkg-b",
        version: "1.0.0"
      }
    ]);

    await pre(cwd, { command: "enter", tag: "next" });
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "patch" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: { "pkg-b": "1.0.0" },
        name: "pkg-a",
        version: "1.1.1-next.0"
      },
      {
        name: "pkg-b",
        version: "1.0.0"
      }
    ]);
  });
  // https://github.com/changesets/changesets/pull/382#discussion_r434434182
  it("should bump patch version for packages that had prereleases, but caret dependencies are still in range", async () => {
    let cwd = f.copy("simple-project-caret-dep");
    await pre(cwd, { command: "enter", tag: "next" });
    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);

    let packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "^1.0.1-next.0"
        },
        name: "pkg-a",
        version: "1.0.1-next.0"
      },
      {
        name: "pkg-b",
        version: "1.0.1-next.0"
      }
    ]);

    await pre(cwd, { command: "exit" });
    await version(cwd, defaultOptions, modifiedDefaultConfig);

    packages = (await getPackages(cwd))!;
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: {
          "pkg-b": "^1.0.1"
        },
        name: "pkg-a",
        version: "1.0.1"
      },
      {
        name: "pkg-b",
        version: "1.0.1"
      }
    ]);
  });

  it("should use the highest bump type between all prereleases when versioning a package", async () => {
    let cwd = f.copy("simple-project");
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "major" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );

    await pre(cwd, { command: "enter", tag: "next" });
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    let packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: { "pkg-b": "1.0.0" },
        name: "pkg-a",
        version: "2.0.0-next.0"
      },
      {
        name: "pkg-b",
        version: "1.0.0"
      }
    ]);

    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "minor" }],
        summary: "a very useful summary for the second change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: { "pkg-b": "1.0.0" },
        name: "pkg-a",
        version: "2.0.0-next.1"
      },
      {
        name: "pkg-b",
        version: "1.0.0"
      }
    ]);
  });
  it("should use the highest bump type between all prereleases when versioning a dependent package", async () => {
    let cwd = f.copy("simple-project");
    await pre(cwd, { command: "enter", tag: "next" });

    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "major" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);
    let packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: { "pkg-b": "1.0.0" },
        name: "pkg-a",
        version: "2.0.0-next.0"
      },
      {
        name: "pkg-b",
        version: "1.0.0"
      }
    ]);

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "minor" }],
        summary: "a very useful summary for the second change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        name: "pkg-a",
        version: "2.0.0-next.1",
        dependencies: { "pkg-b": "1.1.0-next.0" }
      },
      {
        name: "pkg-b",
        version: "1.1.0-next.0"
      }
    ]);
  });

  it("should not bump packages through devDependencies", async () => {
    let cwd = f.copy("simple-dev-dep");
    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "major" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );

    await pre(cwd, { command: "enter", tag: "next" });
    await version(cwd, defaultOptions, modifiedDefaultConfig);
    let packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        devDependencies: { "pkg-b": "2.0.0-next.0" },
        name: "pkg-a",
        version: "1.0.0"
      },
      {
        name: "pkg-b",
        version: "2.0.0-next.0"
      }
    ]);
  });
  it("should not bump ignored packages through dependencies", async () => {
    let cwd = f.copy("simple-project");
    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "major" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "major" }],
        summary: "a very useful summary for the first change"
      },
      cwd
    );

    await pre(cwd, { command: "enter", tag: "next" });
    await version(cwd, defaultOptions, {
      ...modifiedDefaultConfig,
      ignore: ["pkg-a"]
    });
    let packages = (await getPackages(cwd))!;

    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        dependencies: { "pkg-b": "2.0.0-next.0" },
        name: "pkg-a",
        version: "1.0.0"
      },
      {
        name: "pkg-b",
        version: "2.0.0-next.0"
      }
    ]);
  });
  it("should bump dependent of prerelease package when bumping a `workspace:~` dependency", async () => {
    const cwd = f.copy("workspace-alias-range-dep");
    await pre(cwd, { command: "enter", tag: "alpha" });

    await writeChangeset(
      {
        releases: [{ name: "pkg-c", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );
    await version(cwd, defaultOptions, modifiedDefaultConfig);

    let packages = await getPackages(cwd);
    expect(packages.packages.map(x => x.packageJson)).toEqual([
      {
        name: "pkg-a",
        version: "1.0.1-alpha.0",
        dependencies: {
          "pkg-b": "workspace:^",
          "pkg-c": "workspace:~"
        }
      },
      {
        name: "pkg-b",
        version: "1.0.0"
      },
      {
        name: "pkg-c",
        version: "1.0.1-alpha.0"
      }
    ]);
  });

  it("should replace star range for dependency in dependant package when that dependency has its first prerelease in an already active pre mode", async () => {
    const cwd = f.copy("simple-star-dep");

    await pre(cwd, { command: "enter", tag: "alpha" });

    await writeChangeset(
      {
        releases: [{ name: "pkg-a", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "*",
          },
          "name": "pkg-a",
          "version": "1.0.1-alpha.0",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.0",
        },
      ]
    `);

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "1.0.1-alpha.0",
          },
          "name": "pkg-a",
          "version": "1.0.1-alpha.1",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.1-alpha.0",
        },
      ]
    `);
  });

  it("bumping dependency in pre mode should result in dependant with star range on that dependency to be patch bumped and that range to be replaced with exact version", async () => {
    const cwd = f.copy("simple-star-dep");

    await pre(cwd, { command: "enter", tag: "alpha" });

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "1.0.1-alpha.0",
          },
          "name": "pkg-a",
          "version": "1.0.1-alpha.0",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.1-alpha.0",
        },
      ]
    `);
  });

  it("bumping dependency in pre mode should result in dependant with workspace:* range on that dependency to be patch bumped without changing the dependency range", async () => {
    const cwd = f.copy("simple-workspace-wildcard-range-dep");

    await pre(cwd, { command: "enter", tag: "alpha" });

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "workspace:*",
          },
          "name": "pkg-a",
          "version": "1.0.1-alpha.0",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.1-alpha.0",
        },
      ]
    `);
  });

  it("bumping dependency in pre mode should result in dependant with workspace:^ range on that dependency to be patch bumped without changing the dependency range", async () => {
    const cwd = f.copy("workspace-alias-range-dep");

    await pre(cwd, { command: "enter", tag: "alpha" });

    await writeChangeset(
      {
        releases: [{ name: "pkg-b", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "workspace:^",
            "pkg-c": "workspace:~",
          },
          "name": "pkg-a",
          "version": "1.0.1-alpha.0",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.1-alpha.0",
        },
        Object {
          "name": "pkg-c",
          "version": "1.0.0",
        },
      ]
    `);
  });

  it("bumping dependency in pre mode should result in dependant with workspace:~ range on that dependency to be patch bumped without changing the dependency range", async () => {
    const cwd = f.copy("workspace-alias-range-dep");

    await pre(cwd, { command: "enter", tag: "alpha" });

    await writeChangeset(
      {
        releases: [{ name: "pkg-c", type: "patch" }],
        summary: "a very useful summary for the change"
      },
      cwd
    );

    await version(cwd, defaultOptions, modifiedDefaultConfig);

    expect((await getPackages(cwd)).packages.map(x => x.packageJson))
      .toMatchInlineSnapshot(`
      Array [
        Object {
          "dependencies": Object {
            "pkg-b": "workspace:^",
            "pkg-c": "workspace:~",
          },
          "name": "pkg-a",
          "version": "1.0.1-alpha.0",
        },
        Object {
          "name": "pkg-b",
          "version": "1.0.0",
        },
        Object {
          "name": "pkg-c",
          "version": "1.0.1-alpha.0",
        },
      ]
    `);
  });

  describe("linked", () => {
    it("should work with linked", async () => {
      let linkedConfig = {
        ...modifiedDefaultConfig,
        linked: [["pkg-a", "pkg-b"]]
      };
      let cwd = f.copy("simple-project");
      await writeChangeset(
        {
          releases: [{ name: "pkg-a", type: "minor" }],
          summary: "a very useful summary"
        },
        cwd
      );
      await version(cwd, defaultOptions, linkedConfig);
      let packages = (await getPackages(cwd))!;

      expect(packages.packages.map(x => x.packageJson)).toEqual([
        {
          dependencies: { "pkg-b": "1.0.0" },
          name: "pkg-a",
          version: "1.1.0"
        },
        {
          name: "pkg-b",
          version: "1.0.0"
        }
      ]);

      await pre(cwd, { command: "enter", tag: "next" });
      await writeChangeset(
        {
          releases: [{ name: "pkg-b", type: "patch" }],
          summary: "a very useful summary"
        },
        cwd
      );
      await version(cwd, defaultOptions, linkedConfig);
      packages = (await getPackages(cwd))!;

      expect(packages.packages.map(x => x.packageJson)).toEqual([
        {
          dependencies: { "pkg-b": "1.1.1-next.0" },
          name: "pkg-a",
          version: "1.1.1-next.0"
        },
        {
          name: "pkg-b",
          version: "1.1.1-next.0"
        }
      ]);
      await writeChangeset(
        {
          releases: [{ name: "pkg-a", type: "patch" }],
          summary: "a very useful summary"
        },
        cwd
      );
      await version(cwd, defaultOptions, linkedConfig);
      packages = (await getPackages(cwd))!;
      expect(packages.packages.map(x => x.packageJson)).toEqual([
        {
          dependencies: { "pkg-b": "1.1.1-next.0" },
          name: "pkg-a",
          version: "1.1.1-next.1"
        },
        {
          name: "pkg-b",
          version: "1.1.1-next.0"
        }
      ]);
      await writeChangeset(
        {
          releases: [{ name: "pkg-a", type: "patch" }],
          summary: "a very useful summary"
        },
        cwd
      );
      await version(cwd, defaultOptions, linkedConfig);
      packages = (await getPackages(cwd))!;
      expect(packages.packages.map(x => x.packageJson)).toEqual([
        {
          dependencies: { "pkg-b": "1.1.1-next.0" },
          name: "pkg-a",
          version: "1.1.1-next.2"
        },
        {
          name: "pkg-b",
          version: "1.1.1-next.0"
        }
      ]);
    });

    it("should use the highest bump type between all prereleases for a linked package when versioning a dependent package", async () => {
      let linkedConfig = {
        ...modifiedDefaultConfig,
        linked: [["pkg-a", "pkg-b"]]
      };
      let cwd = f.copy("linked-and-not-linked-packages");
      await pre(cwd, { command: "enter", tag: "next" });
      await writeChangeset(
        {
          releases: [{ name: "pkg-a", type: "minor" }],
          summary: "a very useful summary"
        },
        cwd
      );
      await version(cwd, defaultOptions, linkedConfig);
      let packages = (await getPackages(cwd))!;

      expect(packages.packages.map(x => x.packageJson)).toEqual([
        {
          name: "pkg-a",
          version: "1.1.0-next.0"
        },
        {
          name: "pkg-b",
          version: "1.0.0",
          dependencies: { "pkg-c": "0.1.0" }
        },
        {
          name: "pkg-c",
          version: "0.1.0"
        }
      ]);

      await writeChangeset(
        {
          releases: [{ name: "pkg-c", type: "patch" }],
          summary: "a very useful summary"
        },
        cwd
      );
      await version(cwd, defaultOptions, linkedConfig);
      packages = (await getPackages(cwd))!;

      expect(packages.packages.map(x => x.packageJson)).toEqual([
        {
          name: "pkg-a",
          version: "1.1.0-next.0"
        },
        {
          name: "pkg-b",
          version: "1.1.0-next.1",
          dependencies: { "pkg-c": "0.1.1-next.0" }
        },
        {
          name: "pkg-c",
          version: "0.1.1-next.0"
        }
      ]);
    });
    it("should not bump a linked package if its linked devDep gets released", async () => {
      let linkedConfig = {
        ...modifiedDefaultConfig,
        linked: [["pkg-a", "pkg-b"]]
      };
      let cwd = f.copy("linked-packages-with-linked-dev-dep");
      await writeChangeset(
        {
          releases: [{ name: "pkg-b", type: "patch" }],
          summary: "a very useful summary"
        },
        cwd
      );
      await version(cwd, defaultOptions, linkedConfig);
      let packages = (await getPackages(cwd))!;

      expect(packages.packages.map(x => x.packageJson)).toEqual([
        {
          name: "pkg-a",
          version: "1.0.0",
          devDependencies: { "pkg-b": "1.0.1" }
        },
        {
          name: "pkg-b",
          version: "1.0.1"
        }
      ]);
    });
  });
});
