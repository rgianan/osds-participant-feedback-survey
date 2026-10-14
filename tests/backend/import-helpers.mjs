import { json } from "../../scripts/lib/code-gs.mjs";

/**
 * What exportForMigration() in Code.gs writes, from a stand-in spreadsheet
 * (contract-harness appsScript()): the real function, run as the editor would.
 */
export function exportFromAppsScript(apps) {
  const files = [];
  apps.gas.Session = {
    getScriptTimeZone: () => "Asia/Manila",
    getActiveUser: () => ({ getEmail: () => "owner@example.com" }),
    getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }),
  };
  apps.gas.DriveApp = {
    createFile: (name, content, mimeType) => {
      files.push({ name, content, mimeType });
      return { getUrl: () => "https://drive.google.com/file/d/export/view" };
    },
  };
  const summary = json(apps.gas.exportForMigration());
  return { exported: JSON.parse(files[0].content), file: files[0], summary };
}

/** A sheet row's cell by header, for editing an export in a test. `sheetRow` counts as Sheets does (header = 1). */
export function setCell(exported, sheet, sheetRow, header, value) {
  const rows = exported.sheets[sheet];
  let column = rows[0].findIndex((h) => String(h).trim().toLowerCase() === header.toLowerCase());
  if (column < 0) throw new Error(`No ${header} column in ${sheet}`);
  while (rows.length < sheetRow) rows.push(rows[0].map(() => ""));
  rows[sheetRow - 1][column] = value;
}

export const manilaDate = (day, time = "00:00") => ({ $date: new Date(`${day}T${time}:00+08:00`).toISOString() });
