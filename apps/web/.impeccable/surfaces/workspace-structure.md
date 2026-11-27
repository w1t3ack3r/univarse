---
version: 1
slug: "workspace-structure"
primary_target: "src/app/(workspace)/workspace/structure"
related_targets: ["src/app/(workspace)/workspace/structure/types"]
---

# Surface brief: the Structure page (the org tree) and its unit types

Scope: the institution's org tree (spec 0042, P2-S1 PR B): the tree, a unit's details and history, creating, editing, moving, deactivating, archiving and reactivating units, "as at a day", and the unit types page. Mode: **Operate**. Inherits the workspace's world (DESIGN.md, "The Friendly Front Desk"); no new identity.

Audience and job (owner, 2026-11-27): **mostly the Registrar or the IT Admin on a desktop, building and restructuring the tree**, rarely after that; other staff look units up. The page must make the institution's shape legible at once and make a restructuring deliberate (a move changes who has authority, T41).

## Direction contract

THESIS: The institution's structure drawn as its own organisation chart: one trunk card for the institution, its top units as hanging branches, every change made beside the chart in a panel, never by accident. It refuses the flat admin table and the file-browser tree.

OWN-WORLD: The workspace's sage ground and white cards; unit nodes are white 14px cards joined by 1.5px field-outline connector lines (a trunk, a bus, hanging stems). Deep-green ink; lime only on the one pressable action of the moment. Status as words plus chips (inactive on sage, archived dashed and muted). Selection is a deep-green 2px ring, never lime.

STORY: The Registrar sees the institution at the top and its faculties, schools and offices beneath, opens a branch, chooses a unit, and reads in the panel what it is and what happened to it. They add, edit or move it there; a drag onto another card only opens the move, which names how many units go with it and that roles on the old parent stop covering them.

FIRST VIEWPORT: Desktop (≥ 1100px): page title "Structure" and its lede; a toolbar row (search, "Show archived", "As at", the lime "Add a unit", a "Unit types" link); below, the chart (trunk card full width, branches in columns of at least 232px) on the left and the 380px sticky panel on the right (below the workspace top bar), empty until a unit is chosen. Phone: the same toolbar wrapped; branches stack in one column; choosing a unit shows the panel in place of the chart, with "Back to the structure".

FORM: hanging organisation chart, the dealt lead of the surface roll (seed 38de888f, index 7 of seven grounded structures; the owner locked it over columns and a directory list).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
