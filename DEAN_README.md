# UniVarse - Dean Portal Documentation

## 🎓 Overview: The Role of the Dean
In the Nigerian University system (and within UniVarse), the **Dean** serves as the **Academic and Administrative Head of a Faculty** (e.g., Faculty of Science, Faculty of Arts). They are the critical bridge between the Departments (led by HODs) and the University Management (Senate/Vice-Chancellor).

The Dean's functionality in UniVarse is designed to reflect this high-level oversight role, focusing on **Quality Assurance**, **Result Approval**, and **Faculty Management**.

---

## 🔑 Key Responsibilities & Capabilities

### 1. Academic Oversight (The "Gatekeeper")
The most critical technical function of the Dean in UniVarse is the **Result Approval Workflow**.
- **Context**: In Nigerian universities, results are processed bottom-up.
- **Workflow**:
    1.  **Lecturer**: Uploads scores (CA + Exam).
    2.  **HOD (Head of Department)**: First-level approval.
    3.  **DEAN**: **Faculty-level approval**. The Dean reviews results from all departments.
        *   *Action*: Can **Approve** (forward to Senate) or **Reject** (send back to HOD for correction).
    4.  **Senate/Exams & Records**: Final ratification.
- **UniVarse Feature**: The Dean has a specialized "Results Board" to view batch results, analyze pass rates, and digitally sign off on mark sheets.

### 2. Faculty Management
- **Department Oversight**: View all departments under the faculty.
- **Staff Oversight**: Access to profiles of HODs and Lecturers within the faculty.
- **Curriculum Compliance**: Ensure departments are adhering to NUC (National Universities Commission) standards for course loads and content (view-only access to curriculums).

### 3. Student Affairs (Faculty Level)
- **Senate List Compilation**: The Dean generates and approves the "Senate List" (list of students eligible for graduation) before it goes to the Senate.
- **Faculty Clearance**: Part of the graduation clearance workflow.
- **Disciplinary Actions**: View and manage serious student disciplinary cases escalated from departments.

---

## 📂 Dean Module Structure

The Dean Portal is located at `/dean`. Below is the comprehensive file structure and the purpose of each route.

```
frontend/src/app/(dashboard)/dean/
├── layout.tsx                # Dean-Specific Sidebar & Navigation Wrapper
├── page.tsx                  # 📊 Main Dashboard (Stats: Departments, Students, Approvals)
├── departments/              # 🏢 Faculty Departments Overview
│   └── page.tsx              # List of Depts, HOD contacts, Performance Stats
├── staff/                    # 👥 Faculty Staff Directory
│   └── page.tsx              # List of Lecturers/Admin staff in the Faculty
├── students/                 # 🎓 Student Registry
│   └── page.tsx              # Filterable list of students in the Faculty
├── results/                  # 📝 Result Approval Center (CRITICAL)
│   ├── page.tsx              # Inbox of Results waiting for approval
│   └── [batchId]/            # Detailed view of a specific result batch
│       └── page.tsx          # Interface to Approve/Reject with comments
├── senate-list/              # 📜 Graduation/Senate List Management
│   └── page.tsx              # Compilation of graduating students
├── reports/                  # 📈 Faculty Reports
│   └── page.tsx              # Charts: Pass rates, Tuition payment stats, etc.
└── settings/                 # ⚙️ Faculty-Specific Settings (if any)
```

---

## 🛠️ Technical Implementation Details

### Permissions
- **Role**: `DEAN`
- **Scope**: Data is strictly scoped to the **Faculty ID** assigned to the Dean account.
    - *Example*: The Dean of Science *cannot* see data from the Faculty of Arts.

### Integration Points
- **Backend**:
    - `GET /api/dean/stats`: High-level dashboard metrics.
    - `GET /api/dean/approvals/pending`: Fetch results waiting for Dean action.
    - `POST /api/results/approve`: Endpoint to digitally sign off results.
- **Database**:
    - Users with `role: DEAN` are linked to a `Faculty` model.

---

## 🇳🇬 Contextual Nuances (Nigerian System)
- **"The Broad sheet"**: Deans are accustomed to seeing "Broad sheets" (large spreadsheets of results). The UI should reflect a dense, data-rich table view for results.
- **Semester System**: Operations are strictly bound by the current **Academic Session** and **Semester** (e.g., "2024/2025 Rain Semester").
- **Level Advisers**: The Dean often communicates directives to Level Advisers through the HODs.

---
*Last Updated: 2026-02-04*
