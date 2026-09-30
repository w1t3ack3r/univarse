'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import Link from 'next/link';

export default function StudentDashboard() {
    const { user, isLoading, isAuthenticated, logout } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.push('/login');
        }
    }, [isLoading, isAuthenticated, router]);

    if (isLoading) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center">
                <div className="animate-spin w-8 h-8 border-4 border-violet-500 border-t-transparent rounded-full"></div>
            </div>
        );
    }

    if (!user) return null;

    // Mock data for demonstration
    const enrolledCourses = [
        { code: 'CSC101', title: 'Introduction to Computer Science', lecturer: 'Dr. Adewale', progress: 75 },
        { code: 'MTH101', title: 'Elementary Mathematics', lecturer: 'Prof. Okonkwo', progress: 60 },
        { code: 'PHY101', title: 'General Physics', lecturer: 'Dr. Ibrahim', progress: 45 },
        { code: 'GST111', title: 'Use of English', lecturer: 'Mrs. Eze', progress: 80 },
    ];

    const upcomingClasses = [
        { course: 'CSC101', topic: 'Data Structures', time: '10:00 AM', venue: 'LT1' },
        { course: 'MTH101', topic: 'Calculus I', time: '2:00 PM', venue: 'LT3' },
    ];

    const recentAnnouncements = [
        { title: 'Mid-Semester Exams', message: 'Mid-semester exams start next week Monday', time: '2 hours ago' },
        { title: 'Assignment Deadline', message: 'CSC101 assignment due by Friday', time: '5 hours ago' },
    ];

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100">
            {/* Header */}
            <header className="bg-white/80 backdrop-blur-xl border-b border-slate-200 sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <div className="flex items-center space-x-3">
                            <div className="w-10 h-10 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl flex items-center justify-center">
                                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                                </svg>
                            </div>
                            <span className="text-xl font-bold bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent">UniVarse</span>
                        </div>

                        <nav className="hidden md:flex items-center space-x-8">
                            <Link href="/student" className="text-violet-600 font-medium">Dashboard</Link>
                            <Link href="/student/courses" className="text-slate-600 hover:text-violet-600 transition-colors">Courses</Link>
                            <Link href="/student/grades" className="text-slate-600 hover:text-violet-600 transition-colors">Grades</Link>
                            <Link href="/student/attendance" className="text-slate-600 hover:text-violet-600 transition-colors">Attendance</Link>
                        </nav>

                        <div className="flex items-center space-x-4">
                            <button className="relative p-2 text-slate-600 hover:text-violet-600 transition-colors">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                                </svg>
                                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
                            </button>
                            <div className="flex items-center space-x-3">
                                <div className="w-10 h-10 bg-gradient-to-br from-violet-400 to-indigo-500 rounded-full flex items-center justify-center text-white font-semibold">
                                    {user.firstName[0]}{user.lastName[0]}
                                </div>
                                <div className="hidden sm:block">
                                    <p className="text-sm font-medium text-slate-900">{user.firstName} {user.lastName}</p>
                                    <p className="text-xs text-slate-500">{user.role}</p>
                                </div>
                            </div>
                            <button
                                onClick={logout}
                                className="p-2 text-slate-600 hover:text-red-600 transition-colors"
                                title="Logout"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Welcome Section */}
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-slate-900">
                        Welcome back, <span className="bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent">{user.firstName}!</span>
                    </h1>
                    <p className="text-slate-600 mt-1">Here's what's happening with your courses today.</p>
                </div>

                {/* Stats Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    {[
                        { label: 'Enrolled Courses', value: '6', icon: '📚', color: 'from-violet-500 to-indigo-500' },
                        { label: 'Attendance Rate', value: '92%', icon: '✅', color: 'from-emerald-500 to-teal-500' },
                        { label: 'Current CGPA', value: '4.25', icon: '🏆', color: 'from-amber-500 to-orange-500' },
                        { label: 'Pending Tasks', value: '3', icon: '📝', color: 'from-rose-500 to-pink-500' },
                    ].map((stat, index) => (
                        <div key={index} className="bg-white rounded-2xl p-6 shadow-lg shadow-slate-200/50 border border-slate-100 hover:shadow-xl transition-shadow">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-slate-500 text-sm">{stat.label}</p>
                                    <p className={`text-3xl font-bold mt-1 bg-gradient-to-r ${stat.color} bg-clip-text text-transparent`}>{stat.value}</p>
                                </div>
                                <div className="text-3xl">{stat.icon}</div>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* My Courses */}
                    <div className="lg:col-span-2">
                        <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-100 overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                                <h2 className="text-lg font-semibold text-slate-900">My Courses</h2>
                            </div>
                            <div className="p-6 space-y-4">
                                {enrolledCourses.map((course, index) => (
                                    <div key={index} className="flex items-center space-x-4 p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors cursor-pointer">
                                        <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-indigo-500 rounded-xl flex items-center justify-center text-white font-bold text-sm">
                                            {course.code.slice(0, 3)}
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-medium text-slate-900">{course.code} - {course.title}</h3>
                                            <p className="text-sm text-slate-500">{course.lecturer}</p>
                                        </div>
                                        <div className="w-24">
                                            <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
                                                <span>Progress</span>
                                                <span>{course.progress}%</span>
                                            </div>
                                            <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 rounded-full transition-all duration-500"
                                                    style={{ width: `${course.progress}%` }}
                                                ></div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Right Sidebar */}
                    <div className="space-y-8">
                        {/* Upcoming Classes */}
                        <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-100 overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                                <h2 className="text-lg font-semibold text-slate-900">Today's Classes</h2>
                            </div>
                            <div className="p-6 space-y-4">
                                {upcomingClasses.map((cls, index) => (
                                    <div key={index} className="flex items-center space-x-4 p-3 bg-gradient-to-r from-violet-50 to-indigo-50 rounded-xl border border-violet-100">
                                        <div className="w-10 h-10 bg-violet-500 rounded-lg flex items-center justify-center text-white text-sm font-bold">
                                            {cls.course.slice(0, 3)}
                                        </div>
                                        <div className="flex-1">
                                            <p className="font-medium text-slate-900">{cls.topic}</p>
                                            <p className="text-xs text-slate-500">{cls.time} • {cls.venue}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Announcements */}
                        <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-100 overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                                <h2 className="text-lg font-semibold text-slate-900">Announcements</h2>
                            </div>
                            <div className="p-6 space-y-4">
                                {recentAnnouncements.map((ann, index) => (
                                    <div key={index} className="p-3 bg-amber-50 rounded-xl border border-amber-100">
                                        <div className="flex items-start space-x-3">
                                            <span className="text-xl">📢</span>
                                            <div>
                                                <p className="font-medium text-slate-900">{ann.title}</p>
                                                <p className="text-sm text-slate-600 mt-1">{ann.message}</p>
                                                <p className="text-xs text-slate-400 mt-2">{ann.time}</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
