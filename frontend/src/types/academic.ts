export interface AcademicSession {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'upcoming' | 'completed';
  isDefault: boolean;
  createdAt: string;
  createdBy: string;
}

export interface CourseRegistrationPeriod {
  id: string;
  sessionId: string;
  sessionName: string;
  registrationStart: string;
  registrationEnd: string;
  lateRegistrationEnd: string;
  status: 'upcoming' | 'active' | 'late' | 'closed';
  createdAt: string;
  createdBy: string;
}

export interface CourseRegistration {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  departmentId: string;
  departmentName: string;
  facultyId: string;
  facultyName: string;
  sessionId: string;
  registrationType: 'regular' | 'late';
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComments?: string;
}

export interface NotificationTemplate {
  id: string;
  type: 'session_start' | 'registration_open' | 'registration_closing' | 'late_registration' | 'registration_closed';
  title: string;
  content: string;
  recipients: 'all' | 'students' | 'faculty' | 'deans' | 'hods';
  isActive: boolean;
}