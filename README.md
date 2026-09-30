# UniVarse - University Management System

## 📋 Project Overview

**UniVarse** is a comprehensive, modern Multi-Tenant University Management System designed specifically for Nigerian universities. It provides a complete digital solution for managing academic operations, student services, and administrative processes through role-based dashboards.

---

## 🎯 Vision

To create the most intuitive and feature-complete university portal system that streamlines academic administration, enhances student experience, and reduces manual paperwork across Nigerian higher education institutions.

---

## 🏗️ System Architecture

### Technology Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Next.js 16 (App Router), React 18, TypeScript |
| **Styling** | Tailwind CSS, shadcn/ui components |
| **Icons** | Lucide React |
| **Notifications** | Sonner (Toast) |
| **State** | React Hooks (useState, useEffect) |
| **Backend** | (Planned) Node.js/Express with Prisma ORM |
| **Database** | (Planned) PostgreSQL |

### Design System

| Element | Value |
|---------|-------|
| **Primary Color** | `#485550` (Dark Sage) |
| **Secondary Color** | `#C0EB6A` (Lime Green) |
| **Background** | `#F4F6F0` (Light Sage) |
| **Font** | System Default |

---

## 👥 User Roles & Portals

### 1. IT Admin Portal (`/it-admin`) ✅ COMPLETE
Full administrative control over all university systems.

### 2. Student Portal (`/student`) 🔄 Planned
Student-facing features for academic activities.

### 3. Lecturer Portal (`/lecturer`) 🔄 Planned
Faculty management and teaching tools.

### 4. Super Admin Portal (`/admin`) 🔄 Planned
High-level system configuration and oversight.

---

## 📦 IT Admin Portal Modules

### Module Summary (8/8 Complete)

| # | Module | Routes | Features | Status |
|---|--------|--------|----------|--------|
| 1 | Dashboard | `/it-admin` | Stats, quick actions, recent activity | ✅ |
| 2 | User Management | `/it-admin/users` | CRUD, roles, activation | ✅ |
| 3 | Academic Structure | `/it-admin/structure` | Faculties, departments, levels | ✅ |
| 4 | Course Management | `/it-admin/courses` | Course CRUD, prerequisites | ✅ |
| 5 | Programmes | `/it-admin/programmes` | Degree programmes, curriculum | ✅ |
| 6 | Sessions | `/it-admin/sessions` | Academic sessions, semesters | ✅ |
| 7 | Admissions | `/it-admin/admissions` | Applications, screening, offers | ✅ |
| 8 | Fee Management | `/it-admin/fees` | Fee structure, payments, waivers | ✅ |
| 9 | Examinations | `/it-admin/examinations` | Timetable, venues, invigilators | ✅ |
| 10 | Results | `/it-admin/results` | Grade entry, GPA, approvals | ✅ |
| 11 | Clearance | `/it-admin/clearance` | Clearance, transcripts, graduation | ✅ |
| 12 | Notifications | `/it-admin/notifications` | Announcements, alerts | ✅ |
| 13 | Support | `/it-admin/support` | Ticket system | ✅ |
| 14 | Settings | `/it-admin/settings` | System configuration | ✅ |

---

## 🔍 Detailed Module Features

### 1. User Management
- User listing with search and filters
- Create/Edit/Delete users
- Role assignment (Student, Lecturer, Staff, Admin)
- Account activation/deactivation
- Password reset

### 2. Academic Structure
- Faculty management (CRUD)
- Department management (nested under faculties)
- Level configuration (100L - 500L)
- Hierarchical tree view

### 3. Course Management
- Course creation with code/title/units
- Department and level assignment
- Prerequisite linking
- Course status (Active/Inactive)

### 4. Programmes
- Degree programme management
- Curriculum builder
- Course allocation per level/semester
- Programme requirements

### 5. Academic Sessions
- Session creation (e.g., 2024/2025)
- Semester management (First/Second)
- Registration period dates
- Session activation

### 6. Admissions
- **Dashboard**: Application stats, charts
- **Applications**: Review, screen, approve/reject
- **Screening**: JAMB score verification
- **Offers**: Admission letter generation
- Merit-based selection

### 7. Fee Management
- **Fee Structure**: Tuition, mandatory, lab fees
- **Payments**: Track student payments
- **Waivers**: Grant fee waivers/scholarships
- Programme-specific fees
- Category grouping (Tuition, Mandatory, Lab, One-Time)

### 8. Examinations
- **Timetable**: Drag-and-drop scheduling
- Flexible time ranges (not fixed slots)
- Time (horizontal) vs Days (vertical) layout
- Add Week / Add Day functionality
- Overlapping exams stack vertically
- **Venues**: Hall/Lab/Classroom management
- **Invigilators**: Assignment and workload
- Combined edit dialog (time + venue + invigilators)
- Fullscreen mode for timetable

### 9. Result Processing
- **Grade Entry**: CA + Exam scores
- Auto-grade calculation (A-F)
- Grade point scale (Nigerian system: A=5, B=4, C=3, D=2, E=1, F=0)
- **GPA/CGPA**: Per semester and cumulative
- **Approval Workflow**: Course Adviser → HOD → Dean → Exam Officer
- **Publication**: Publish approved results
- **Verification**: Student lookup with printable result slip
- Academic standing classification (First Class to Probation)

### 10. Clearance & Graduation
- **Multi-Stage Clearance**:
  - Library (no outstanding books)
  - Bursary (fees paid)
  - Department (course completion)
  - Hostel (no damages)
  - Sports (returned equipment)
  - Student Affairs (no disciplinary issues)
- Visual progress tracker
- Approve/Reject with comments
- **Transcripts**: Request processing workflow
- **Graduation**: Senate list generation
- Filter by department/classification
- Export to Excel
- **NYSC**: Mobilization eligibility list

---

## 🇳🇬 Nigerian University Standards

### Grade System
| Grade | Score | GP | Description |
|-------|-------|-----|-------------|
| A | 70-100 | 5.0 | Excellent |
| B | 60-69 | 4.0 | Very Good |
| C | 50-59 | 3.0 | Good |
| D | 45-49 | 2.0 | Fair |
| E | 40-44 | 1.0 | Pass |
| F | 0-39 | 0.0 | Fail |

### Academic Standing
| Classification | CGPA Range |
|----------------|------------|
| First Class | 4.50 - 5.00 |
| Second Class Upper | 3.50 - 4.49 |
| Second Class Lower | 2.40 - 3.49 |
| Third Class | 1.50 - 2.39 |
| Pass | 1.00 - 1.49 |
| Probation | < 1.00 |

### Fee Categories
- Tuition Fees
- Mandatory Fees (Sports, Library, Medical, etc.)
- Lab/Practical Fees
- One-Time Fees (Matriculation, ID Card, etc.)

---

## 📁 Project Structure

```
univarse/
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── (dashboard)/
│   │   │   │   ├── it-admin/
│   │   │   │   │   ├── page.tsx          # Dashboard
│   │   │   │   │   ├── layout.tsx        # Sidebar & navigation
│   │   │   │   │   ├── users/
│   │   │   │   │   ├── structure/
│   │   │   │   │   ├── courses/
│   │   │   │   │   ├── programmes/
│   │   │   │   │   ├── sessions/
│   │   │   │   │   ├── admissions/
│   │   │   │   │   ├── fees/
│   │   │   │   │   ├── examinations/
│   │   │   │   │   ├── results/
│   │   │   │   │   ├── clearance/
│   │   │   │   │   ├── notifications/
│   │   │   │   │   ├── support/
│   │   │   │   │   └── settings/
│   │   │   │   ├── student/
│   │   │   │   └── lecturer/
│   │   │   ├── login/
│   │   │   └── register/
│   │   ├── components/
│   │   │   └── ui/                # shadcn components
│   │   └── lib/
│   │       └── api.ts
│   ├── package.json
│   └── tailwind.config.ts
└── backend/                       # (Planned)
```

---

## 🚀 Build Status

- **Total Routes**: 23
- **Build**: ✅ Passing
- **Feature Coverage**: 96% (67/70)

---

## 📈 Progress Summary

| Metric | Value |
|--------|-------|
| IT Admin Modules | 8/8 (100%) |
| Total Features | 67/70 (96%) |
| Routes | 23 |
| Lines of Code | ~10,000+ |

### Remaining Minor Features
- SMS Notifications
- Audit Logs
- Advanced Reporting

---

## 🔜 Next Steps

1. **Student Portal** - Course registration, results view, fee payment
2. **Lecturer Portal** - Grade entry, course materials, attendance
3. **Backend Integration** - API development with Prisma/PostgreSQL
4. **Authentication** - JWT-based auth with role permissions
5. **Mobile Responsiveness** - Full mobile optimization

---

## 👨‍💻 Development Notes

### UI/UX Principles
- Intuitive drag-and-drop interfaces where applicable
- Minimal typing, maximum selection
- Visual feedback with toast notifications
- Consistent color scheme across all modules
- Responsive grid layouts

### Code Patterns
- TypeScript for type safety
- React functional components with hooks
- Mock data for frontend prototyping
- Modular component structure
- Consistent naming conventions

---

## 📄 License

Proprietary - UniVarse Project

---

*Last Updated: January 19, 2026*
