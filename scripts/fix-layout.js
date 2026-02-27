const fs = require("fs");
const p = "webview-ui/public/assets/default-layout.json";
const layout = JSON.parse(fs.readFileSync(p, "utf-8"));

function moveFurn(uid, newCol, newRow) {
  const f = layout.furniture.find(x => x.uid === uid);
  if (!f) return;
  if (f.col !== newCol || f.row !== newRow) {
    console.log(f.type.padEnd(28) + " (" + f.col + "," + f.row + ") -> (" + newCol + "," + newRow + ")");
  }
  f.col = newCol;
  f.row = newRow;
}

// Right wall cabinets: even spacing (rows 0,3,6,9)
moveFurn("fc-tall-l1", 12, 0);
moveFurn("fc-big-l1",  12, 3);
moveFurn("fc-wide-l1", 12, 6);
moveFurn("fc-open-l1", 12, 9);

// Bookshelf below cabinets
moveFurn("bs-left-1", 13, 12);

// Misc alignment
moveFurn("bin-1", 10, 7);
moveFurn("plant-big-2", 1, 13);
moveFurn("plant-sm-1", 11, 14);

// Break room tidy
moveFurn("break-ch2", 22, 6);
moveFurn("break-sofa", 21, 8);
moveFurn("plant-b3", 24, 8);
moveFurn("break-ch3", 22, 11);
moveFurn("break-table-2", 22, 12);
moveFurn("break-ch4", 23, 13);

fs.writeFileSync(p, JSON.stringify(layout, null, 2));

// Also update user layout
const userPath = require("os").homedir() + "/.pixel-agents/layout.json";
if (fs.existsSync(userPath)) {
  const userLayout = JSON.parse(fs.readFileSync(userPath, "utf-8"));
  for (const f of userLayout.furniture) {
    const match = layout.furniture.find(x => x.uid === f.uid);
    if (match && (f.col !== match.col || f.row !== match.row)) {
      f.col = match.col;
      f.row = match.row;
    }
    // Also ensure type matches
    const matchByUid = layout.furniture.find(x => x.uid === f.uid);
    if (matchByUid) f.type = matchByUid.type;
  }
  fs.writeFileSync(userPath, JSON.stringify(userLayout, null, 2));
  console.log("User layout synced");
}

console.log("\nLayout cleaned up");
