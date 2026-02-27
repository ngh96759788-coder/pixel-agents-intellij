const fs = require("fs");
const os = require("os");

function fixLayout(layoutPath) {
  if (!fs.existsSync(layoutPath)) return;
  const layout = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
  let changed = 0;

  function updateFurn(uid, updates) {
    const f = layout.furniture.find(x => x.uid === uid);
    if (!f) return;
    const changes = [];
    for (const [key, val] of Object.entries(updates)) {
      if (f[key] !== val) {
        changes.push(key + ":" + f[key] + "->" + val);
        f[key] = val;
        changed++;
      }
    }
    if (changes.length > 0) {
      console.log("  " + (f.type || "").padEnd(20) + f.uid.padEnd(16) + changes.join(", "));
    }
  }

  // Back-facing desks have backgroundTiles:1, so chairs can be on the desk's top row.
  // Desk row 3 → chairs at row 3 (ON the desk, not above it)
  updateFurn("chair-1", { type: "CHAIR_BIG", col: 2, row: 3 });
  updateFurn("chair-2", { type: "CHAIR_2_BIG", col: 5, row: 3 });
  updateFurn("chair-3", { type: "CHAIR_BIG", col: 8, row: 3 });

  // Desk row 9 → chairs at row 9
  updateFurn("chair-4", { type: "CHAIR_BIG", col: 2, row: 9 });
  updateFurn("chair-5", { type: "CHAIR_2_BIG", col: 5, row: 9 });
  updateFurn("chair-6", { type: "CHAIR_BIG", col: 8, row: 9 });

  // Boss desk row 13 → boss chair at row 13
  updateFurn("boss-chair-1", { col: 4, row: 13 });

  fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2));
  console.log("  -> " + changed + " changes\n");
}

console.log("=== Default layout ===");
fixLayout("webview-ui/public/assets/default-layout.json");
console.log("=== User layout ===");
fixLayout(os.homedir() + "/.pixel-agents/layout.json");
