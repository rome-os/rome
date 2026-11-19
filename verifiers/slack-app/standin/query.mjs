// The stand-in's Rome Cloud query command: reads SQL on stdin, ignores it,
// and prints the newest sign-in attempt as the real query would, from the
// stand-in Rome Cloud at argv[2].

const cloud = process.argv[2];
let sql = "";
for await (const chunk of process.stdin) sql += chunk;
if (!/slack_app_installs/.test(sql)) {
  process.stderr.write("the stand-in answers only the sign-in attempt query\n");
  process.exit(2);
}
const rows = await (await fetch(`${cloud}/cloud/attempts`)).json();
process.stdout.write(JSON.stringify(rows));
