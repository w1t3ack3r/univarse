export interface Course {
  id: string;
  courseCode: string;
  courseName: string;
  creditUnits: number;
  semester: 'first' | 'second';
  level: number;
  isCore: boolean;
  departmentId: string;
  departmentName: string;
  prerequisites?: string[];
  description?: string;
}

export interface ProgramLevel {
  level: number;
  courses: Course[];
}

export interface Programme {
  id: string;
  name: string;
  code: string;
  departmentId: string;
  departmentName: string;
  degreeType: 'bachelor' | 'master' | 'phd' | 'diploma' | 'certificate';
  duration: number;
  description: string;
  levels: ProgramLevel[];
  totalCreditUnits: number;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
}

export interface StudentProgramRegistration {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  matricNumber: string;
  programmeId: string;
  programmeName: string;
  programmeCode: string;
  departmentId: string;
  departmentName: string;
  facultyId: string;
  facultyName: string;
  currentLevel: number;
  sessionId: string;
  sessionName: string;
  registrationType: 'regular' | 'late';
  status: 'pending' | 'approved' | 'rejected';
  courses: Course[];
  totalCreditUnits: number;
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComments?: string;
}