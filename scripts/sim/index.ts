const game = process.argv[2];
const rest = process.argv.slice(3);
if (!game) {
  console.log("usage: npm run sim -- <breakwater|wildfire|abyss> [runs]");
  process.exit(1);
}
process.argv = [process.argv[0], process.argv[1], ...rest];
await import(`./${game}.ts`);
