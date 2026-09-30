'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function LecturerDashboard() {
    const { user, isLoading, isAuthenticated, logout } = useAuth();
    const router = useRouter();
    const [activeTab, setActiveTab] = useState<'overview' | 'courses' | 'attendance'>('overview');

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

    // Mock data
    const assignedCourses = [
        { code: 'CSC101', title: 'Introduction to Computer Science', students: 120, level: 100 },
        { code: 'CSC201', title: 'Data Structures and Algorithms', students: 95, level: 200 },
        { code: 'CSC301', title: 'Software Engineering', students: 78, level: 300 },
    ];

    const recentSubmissions = [
        { student: 'John Doe', course: 'CSC101', assignment: 'Assignment 1', time: '2 hours ago', status: 'pending' },
        { student: 'Jane Smith', course: 'CSC201', assignment: 'Lab Report 3', time: '4 hours ago', status: 'pending' },
        { student: 'Mike Johnson', course: 'CSC101', assignment: 'Assignment 1', time: '5 hours ago', status: 'graded' },
    ];

    const upcomingClasses = [
        { course: 'CSC101', topic: 'Introduction to Arrays', time: '10:00 AM', venue: 'LT1', students: 120 },
        { course: 'CSC201', topic: 'Binary Trees', time: '2:00 PM', venue: 'LT5', students: 95 },
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
                            <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs font-medium rounded-full">Lecturer</span>
                        </div>

                        <div className="flex items-center space-x-4">
                            <button className="relative p-2 text-slate-600 hover:text-violet-600 transition-colors">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                                </svg>
                                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
                            </button>
                            <div className="flex items-center space-x-3">
                                <div className="w-10 h-10 bg-gradient-to-br from-emerald-400 to-teal-500 rounded-full flex items-center justify-center text-white font-semibold">
                                    {user.firstName[0]}{user.lastName[0]}
                                </div>
                                <div className="hidden sm:block">
                                    <p className="text-sm font-medium text-slate-900">Dr. {user.firstName} {user.lastName}</p>
                                    <p className="text-xs text-slate-500">Computer Science Dept.</p>
                                </div>
                            </div>
                            <button onClick={logout} className="p-2 text-slate-600 hover:text-red-600 transition-colors">
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
                        Good morning, <span className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">Dr. {user.lastName}!</span>
                    </h1>
                    <p className="text-slate-600 mt-1">Manage your courses, track attendance, and grade students.</p>
                </div>

                {/* Quick Stats */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    {[
                        { label: 'Total Students', value: '293', icon: '👨‍🎓', color: 'from-emerald-500 to-teal-500' },
                        { label: 'Active Courses', value: '3', icon: '📚', color: 'from-violet-500 to-indigo-500' },
                        { label: 'Pending Grades', value: '24', icon: '📝', color: 'from-amber-500 to-orange-500' },
                        { label: 'Today\'s Classes', value: '2', icon: '🎯', color: 'from-rose-500 to-pink-500' },
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
                            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                                <h2 className="text-lg font-semibold text-slate-900">My Courses</h2>
                                <button className="text-sm text-violet-600 hover:text-violet-700 font-medium">+ Add Course</button>
                            </div>
                            <div className="p-6 space-y-4">
                                {assignedCourses.map((course, index) => (
                                    <div key={index} className="flex items-center space-x-4 p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors cursor-pointer group">
                                        <div className="w-14 h-14 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-xl flex items-center justify-center text-white font-bold">
                                            {course.code.slice(0, 3)}
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-medium text-slate-900">{course.code} - {course.title}</h3>
                                            <p className="text-sm text-slate-500">{course.students} students • Level {course.level}</p>
                                        </div>
                                        <div className="flex items-center space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button className="p-2 bg-emerald-100 text-emerald-600 rounded-lg hover:bg-emerald-200" title="Take Attendance">
                                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                            </button>
                                            <button className="p-2 bg-violet-100 text-violet-600 rounded-lg hover:bg-violet-200" title="Upload Materials">
                                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                                </svg>
                                            </button>
                                            <button className="p-2 bg-amber-100 text-amber-600 rounded-lg hover:bg-amber-200" title="Grade Students">
                                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Recent Submissions */}
                        <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-100 overflow-hidden mt-8">
                            <div className="p-6 border-b border-slate-100">
                                <h2 className="text-lg font-semibold text-slate-900">Recent Submissions</h2>
                            </div>
                            <div className="divide-y divide-slate-100">
                                {recentSubmissions.map((sub, index) => (
                                    <div key={index} className="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center space-x-3">
                                            <div className="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center text-slate-600 font-medium">
                                                {sub.student.split(' ').map(n => n[0]).join('')}
                                            </div>
                                            <div>
                                                <p className="font-medium text-slate-900">{sub.student}</p>
                                                <p className="text-sm text-slate-500">{sub.course} • {sub.assignment}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center space-x-3">
                                            <span className="text-xs text-slate-400">{sub.time}</span>
                                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${sub.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                                                }`}>
                                                {sub.status}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Right Sidebar */}
                    <div className="space-y-8">
                        {/* Today's Schedule */}
                        <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-100 overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                                <h2 className="text-lg font-semibold text-slate-900">Today's Schedule</h2>
                            </div>
                            <div className="p-6 space-y-4">
                                {upcomingClasses.map((cls, index) => (
                                    <div key={index} className="p-4 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-xl border border-emerald-100">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="font-semibold text-slate-900">{cls.course}</span>
                                            <span className="text-sm text-emerald-600 font-medium">{cls.time}</span>
                                        </div>
                                        <p className="text-sm text-slate-600">{cls.topic}</p>
                                        <div className="flex items-center justify-between mt-2 text-xs text-slate-500">
                                            <span>📍 {cls.venue}</span>
                                            <span>👥 {cls.students} students</span>
                                        </div>
                                        <button className="w-full mt-3 py-2 bg-emerald-500 text-white text-sm font-medium rounded-lg hover:bg-emerald-600 transition-colors">
                                            Start Class
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Quick Actions */}
                        <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-100 overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                                <h2 className="text-lg font-semibold text-slate-900">Quick Actions</h2>
                            </div>
                            <div className="p-4 grid grid-cols-2 gap-3">
                                {[
                                    { icon: '📤', label: 'Upload Material', color: 'bg-violet-50 text-violet-600 hover:bg-violet-100' },
                                    { icon: '✅', label: 'Take Attendance', color: 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' },
                                    { icon: '📝', label: 'Create Assignment', color: 'bg-amber-50 text-amber-600 hover:bg-amber-100' },
                                    { icon: '📊', label: 'View Reports', color: 'bg-blue-50 text-blue-600 hover:bg-blue-100' },
                                ].map((action, index) => (
                                    <button key={index} className={`p-4 rounded-xl text-center transition-colors ${action.color}`}>
                                        <span className="text-2xl block mb-1">{action.icon}</span>
                                        <span className="text-xs font-medium">{action.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
