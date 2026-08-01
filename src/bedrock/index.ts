// The "./bedrock" subpath export — the only entry that pulls in the AWS SDK.
//
//   import { ask } from "@spore-host/advisor-ts";
//   import { bedrockConverse } from "@spore-host/advisor-ts/bedrock";
//
//   const converse = bedrockConverse({ client, modelId: "us.anthropic.claude-..." });
//   const answer = await ask("what should I run gromacs on?", { converse, backends });
//
// Split out for the same reason truffle-ts splits "./live": a consumer of the pure
// core must not ship megabytes of SDK it never calls. src/core/isolation.test.ts
// enforces that the default entry never reaches an `@aws-sdk/*` import, and that
// this one does.
//
// Every call through here is billable inference in the caller's own AWS account.

export { bedrockConverse, bedrockConverseStream } from "./converse.js";
export type { BedrockOptions } from "./converse.js";
export { listModels } from "./models.js";
export type { AvailableModel } from "./models.js";
