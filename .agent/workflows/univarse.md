---
description: UniVarse Project Context and Development Workflow
---

# UniVarse Development Workflow

## Project Overview

UniVarse is a comprehensive university management system for Nigerian universities with role-based dashboards.

## Technology Stack

- **Frontend**: Next.js 16 (App Router), React 18, TypeScript
- **Styling**: Tailwind CSS, shadcn/ui
- **Icons**: Lucide React
- **Notifications**: Sonner (toast)

## Design System

| Element | Value |
|---------|-------|
| Primary Color | `#485550` (Dark Sage) |
| Secondary Color | `#C0EB6A` (Lime Green) |
| Background | `#F4F6F0` (Light Sage) |

## Nigerian University Standards

### Grade System
- A: 70-100 (5.0 GP) | B: 60-69 (4.0) | C: 50-59 (3.0) | D: 45-49 (2.0) | E: 40-44 (1.0) | F: 0-39 (0.0)

### Academic Standing
- First Class: 4.50-5.00 | 2:1: 3.50-4.49 | 2:2: 2.40-3.49 | Third: 1.50-2.39 | Probation: <1.00

## Development Commands

// turbo-all

1. Start dev server: `npm run dev` (in frontend/)
2. Build: `npm run build` (in frontend/)
3. Type check: `npx tsc --noEmit` (in frontend/)

## File Structure

```
univarse/frontend/src/app/(dashboard)/
├── it-admin/          # IT Admin Portal (COMPLETE)
├── student/           # Student Portal (Planned)
└── lecturer/          # Lecturer Portal (Planned)
```

## Completed Modules (IT Admin)

1. Dashboard, Users, Academic Structure, Courses
2. Programmes, Sessions, Admissions, Fees
3. Examinations, Results, Clearance

## Code Patterns

- Use TypeScript interfaces for all data types
- Mock data with realistic Nigerian university context
- shadcn/ui components with custom color classes
- Toast notifications via `sonner`
- Tabs for multi-section pages
- Dialogs for create/edit forms

## UI Patterns

- Stats cards at top of pages
- Tabbed navigation for multi-feature pages
- Table or card layouts for listings
- Badges for status indicators
- Button colors: Primary `bg-[#485550]`, Secondary `bg-[#C0EB6A]`
