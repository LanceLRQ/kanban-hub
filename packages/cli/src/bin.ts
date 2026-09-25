import { createNodeContext } from "./context";
import { main } from "./main";

const ctx = createNodeContext();
process.exitCode = await main(process.argv.slice(2), ctx);
