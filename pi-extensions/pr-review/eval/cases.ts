import type { FindingKind } from "../src/types.ts";

export interface EvaluationCase {
  id: string;
  intent: string;
  base: Record<string, string>;
  target: Record<string, string>;
  exclude?: string[];
  expected: { description: string; findings: { file: string; kind: FindingKind }[] };
}
const packageJSON = '{"name":"fixture","type":"module","engines":{"node":">=22.13"}}\n';
const goTest = 'package counter\nimport "testing"\nfunc TestCount(t *testing.T) { for n, want := range map[int]int{0:0,1:1,3:6} { if Count(n) != want { t.Fatal(n) } } }\n';
const loop = 'package counter\nfunc Count(n int) int { total:=0; for i:=0;i<n;i++ { total+=i+1 }; return total }\n';
const ranged = 'package counter\nfunc Count(n int) int { total:=0; for i:=range n { total+=i+1 }; return total }\n';
const authTests = 'import {test} from "node:test"; import assert from "node:assert/strict"; import {read} from "./auth.js";\ntest("authorized",()=>assert.equal(read(true),"data"));\ntest("unauthorized",()=>assert.throws(()=>read(false),/denied/));\n';
export const cases: EvaluationCase[] = [
  {
    id: "removed-cleanup", intent: "Simplify callback resource handling while preserving cleanup on success and failure.",
    base: { "package.json": packageJSON, "resource.ts": 'export function use(file:{open():void;close():void}, action:()=>number):number { file.open(); try { return action() } finally { file.close() } }\n',
      "resource.test.ts": 'import {test} from "node:test"; import assert from "node:assert/strict"; import {use} from "./resource.js";\ntest("cleanup",()=>{let closed=false;const file={open(){},close(){closed=true}};assert.equal(use(file,()=>42),42);assert.equal(closed,true)});\ntest("failure cleanup",()=>{let closed=false;const file={open(){},close(){closed=true}};assert.throws(()=>use(file,()=>{throw Error("failure")}));assert.equal(closed,true)});\n' },
    target: { "resource.ts": 'export function use(file:{open():void;close():void}, action:()=>number):number { file.open(); return action() }\n' },
    expected: { description: "Removed finally no longer closes the resource on either path. Existing tests expose the intended contract; do not pretend they were run.", findings: [{ file: "resource.ts", kind: "defect" }] },
  },
  {
    id: "guard-preserved", intent: "Move authorization into one helper without changing allowed access.",
    base: { "package.json": packageJSON, "auth.ts": 'export function read(allowed:boolean):string { if(!allowed) throw Error("denied"); return "data" }\n', "auth.test.ts": authTests },
    target: { "auth.ts": 'import {requireAccess} from "./guard.js";\nexport function read(allowed:boolean):string { requireAccess(allowed); return "data" }\n', "guard.ts": 'export function requireAccess(allowed:boolean):void { if(!allowed) throw Error("denied") }\n' },
    expected: { description: "Clean: removed inline guard is re-established by the called helper; public-path tests still pin authorization. No additional test level is required.", findings: [] },
  },
  {
    id: "recent-language-valid", intent: "Simplify iteration while retaining the same count behavior.",
    base: { "go.mod": "module example.invalid/counter\ngo 1.22\n", "counter.go": loop, "counter_test.go": goTest },
    target: { "counter.go": ranged },
    expected: { description: "Clean: range over integers is available at the declared Go 1.22 language version. Do not flag it from stale memory.", findings: [] },
  },
  {
    id: "language-version-mismatch", intent: "Simplify iteration while retaining the supported Go language version.",
    base: { "go.mod": "module example.invalid/counter\ngo 1.21\n", "counter.go": loop, "counter_test.go": goTest },
    target: { "counter.go": ranged },
    expected: { description: "Integer range requires Go 1.22, but the owning module declares Go 1.21. Compilation compatibility is a concrete defect, not a guessed unknown API.", findings: [{ file: "counter.go", kind: "defect" }] },
  },
  {
    id: "self-confirming-test", intent: "Add a useful regression case for the existing discount behavior.",
    base: { "package.json": packageJSON, "price.ts": "export const price=(amount:number)=>amount*0.9;\n",
      "price.test.ts": 'import {test} from "node:test"; import assert from "node:assert/strict"; import {price} from "./price.js";\ntest("discount",()=>assert.equal(price(100),90));\n' },
    target: { "price.test.ts": 'import {test} from "node:test"; import assert from "node:assert/strict"; import {price} from "./price.js";\ntest("discount",()=>assert.equal(price(100),90));\ntest("extra case",()=>{const expected=price(100);assert.equal(price(100),expected)});\n' },
    expected: { description: "New self-confirming assertion adds no distinct failure detection; its expected value comes from the subject. An improvement, not evidence that discount computation is broken.", findings: [{ file: "price.test.ts", kind: "improvement" }] },
  },
  {
    id: "public-secret-boundary", intent: "Add diagnostic information without disclosing credentials to public callers.",
    base: { "package.json": packageJSON, "response.ts": 'export function response(path:string,env:Record<string,string|undefined>):unknown { if(path==="/health") return {ok:true};return {status:404} }\n',
      "server.ts": 'import {createServer} from "node:http";import {response} from "./response.js";\ncreateServer((req,res)=>res.end(JSON.stringify(response(req.url??"/",process.env)))).listen(8080,"0.0.0.0");\n',
      "response.test.ts": 'import {test} from "node:test";import assert from "node:assert/strict";import {response} from "./response.js";\ntest("health",()=>assert.deepEqual(response("/health",{}),{ok:true}));\ntest("closed route",()=>assert.deepEqual(response("/debug",{API_TOKEN:"fixture"}),{status:404}));\n' },
    target: { "response.ts": 'export function response(path:string,env:Record<string,string|undefined>):unknown { if(path==="/health") return {ok:true};if(path==="/debug") return {token:env.API_TOKEN};return {status:404} }\n' },
    expected: { description: "Unauthenticated HTTP callers gain access to an environment credential via the newly reachable public route. Require a concrete threat-boundary explanation.", findings: [{ file: "response.ts", kind: "defect" }] },
  },
  {
    id: "trusted-local-environment", intent: "The fixed trusted git executable runs as the same OS user; intentionally inherit its authentication environment. Do not add network/log output or accept arbitrary executables.",
    base: { "package.json": packageJSON, "environment.ts": 'export function environment(base:NodeJS.ProcessEnv):NodeJS.ProcessEnv { return {PATH:base.PATH} }\n',
      "tool.ts": 'import {spawnSync} from "node:child_process";import {environment} from "./environment.js";\nexport function status(){return spawnSync("git",["status"],{env:environment(process.env),stdio:"ignore",shell:false}).status}\n',
      "environment.test.ts": 'import {test} from "node:test";import assert from "node:assert/strict";import {environment} from "./environment.js";\ntest("path",()=>assert.equal(environment({PATH:"fixture"}).PATH,"fixture"));\n' },
    target: { "environment.ts": 'export function environment(base:NodeJS.ProcessEnv):NodeJS.ProcessEnv { return {...base} }\n',
      "environment.test.ts": 'import {test} from "node:test";import assert from "node:assert/strict";import {environment} from "./environment.js";\ntest("path",()=>assert.equal(environment({PATH:"fixture"}).PATH,"fixture"));\ntest("authentication environment",()=>assert.equal(environment({GIT_TOKEN:"fixture"}).GIT_TOKEN,"fixture"));\n' },
    expected: { description: "Clean under stated/source-visible same-user trusted-executable model. Environment inheritance alone is not a new unauthorized trust boundary.", findings: [] },
  },
  {
    id: "excluded-lockfile-updated", intent: "Update an existing dependency's patch version; keep dependency resolution synchronized.",
    base: { "package.json": '{"name":"fixture","engines":{"node":">=22.13"},"dependencies":{"fixture-lib":"1.0.0"}}\n',
      "package-lock.json": '{"name":"fixture","lockfileVersion":3,"packages":{"":{"dependencies":{"fixture-lib":"1.0.0"}},"node_modules/fixture-lib":{"version":"1.0.0"}}}\n' },
    target: { "package.json": '{"name":"fixture","engines":{"node":">=22.13"},"dependencies":{"fixture-lib":"1.0.1"}}\n',
      "package-lock.json": '{"name":"fixture","lockfileVersion":3,"packages":{"":{"dependencies":{"fixture-lib":"1.0.1"}},"node_modules/fixture-lib":{"version":"1.0.1"}}}\n' },
    exclude: ["package-lock.json"],
    expected: { description: "Clean: companion lockfile changed but is excluded from diff bodies. Unknown dependency semantics must not become invented security/API findings.", findings: [] },
  },
];
