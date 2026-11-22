import * as git from "./git.js";
import * as npm from "./npm.js";
import * as pnpm from "./pnpm.js";
import * as bun from "./bun.js";
import * as cargo from "./cargo.js";
import * as pytest from "./pytest.js";
import * as vitest from "./vitest.js";
import * as jest from "./jest.js";
import * as tsc from "./tsc.js";
import * as eslint from "./eslint.js";
import * as biome from "./biome.js";
import * as go from "./go.js";
import * as ruff from "./ruff.js";
import * as prettier from "./prettier.js";
import * as playwright from "./playwright.js";
import * as docker from "./docker.js";
import * as kubectl from "./kubectl.js";
import * as terraform from "./terraform.js";
import * as gradle from "./gradle.js";
import * as make from "./make.js";
import * as pip from "./pip.js";
import * as uv from "./uv.js";
import * as curl from "./curl.js";
import * as wget from "./wget.js";
const modules = [git, npm, pnpm, bun, cargo, pytest, vitest, jest, tsc, eslint, biome, go, ruff, prettier, playwright, docker, kubectl, terraform, gradle, make, pip, uv, curl, wget];
export const FAMILIES = Object.freeze(modules
    .map((m) => ({ id: m.id, priority: m.priority ?? 10, match: m.match, compress: m.compress }))
    .sort((a, b) => b.priority - a.priority));
