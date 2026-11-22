export interface CommandFamily {
  id: string;
  priority: number;
  match: (ctx: any) => boolean;
  compress: (text: string, ctx?: any) => string;
}
import * as git from "./git.ts";
import * as npm from "./npm.ts";
import * as pnpm from "./pnpm.ts";
import * as bun from "./bun.ts";
import * as cargo from "./cargo.ts";
import * as pytest from "./pytest.ts";
import * as vitest from "./vitest.ts";
import * as jest from "./jest.ts";
import * as tsc from "./tsc.ts";
import * as eslint from "./eslint.ts";
import * as biome from "./biome.ts";
import * as go from "./go.ts";
import * as ruff from "./ruff.ts";
import * as prettier from "./prettier.ts";
import * as playwright from "./playwright.ts";
import * as docker from "./docker.ts";
import * as kubectl from "./kubectl.ts";
import * as terraform from "./terraform.ts";
import * as gradle from "./gradle.ts";
import * as make from "./make.ts";
import * as pip from "./pip.ts";
import * as uv from "./uv.ts";
import * as curl from "./curl.ts";
import * as wget from "./wget.ts";

const modules = [git, npm, pnpm, bun, cargo, pytest, vitest, jest, tsc, eslint, biome, go, ruff, prettier, playwright, docker, kubectl, terraform, gradle, make, pip, uv, curl, wget];
export const FAMILIES = Object.freeze(
  modules
    .map((m) => ({ id: m.id, priority: m.priority ?? 10, match: m.match, compress: m.compress }))
    .sort((a, b) => b.priority - a.priority),
);
