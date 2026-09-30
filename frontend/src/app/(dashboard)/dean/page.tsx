'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Users,
    GraduationCap,
    Building2,
    ClipboardCheck,
    FileText,
    Clock,
    ArrowRight,
    TrendingUp,
    AlertCircle
} from 'lucide-react';
import Link from 'next/link';

// Mock Data
const stats = [
    {
        title: 'Total Students',
        value: '2,453',
        change: '+12% from last session',
        icon: GraduationCap,
        color: 'text-blue-600',
        bg: 'bg-blue-100'
    },
    {
        title: 'Departments',
        value: '8',
        change: 'All active',
        icon: Building2,
        color: 'text-[#485550]',
        bg: 'bg-[#F4F6F0]'
    },
    {
        title: 'Pending Results',
        value: '14',
        change: 'Requires immediate attention',
        icon: ClipboardCheck,
        color: 'text-amber-600',
        bg: 'bg-amber-100',
        alert: true
    },
    {
        title: 'Senate List',
        value: '342',
        change: 'Candidates for graduation',
        icon: FileText,
        color: 'text-[#C0EB6A]',
        bg: 'bg-[#485550]'
    },
];

const recentActivity = [
    {
        id: 1,
        type: 'RESULT_SUBMISSION',
        message: 'Dr. Adewale (HOD, Computer Science) submitted results for CSC 401',
        time: '2 hours ago',
        status: 'PENDING'
    },
    {
        id: 2,
        type: 'SENATE_APPROVAL',
        message: 'Senate List for Faculty of Science approved by Exams & Records',
        time: '5 hours ago',
        status: 'APPROVED'
    },
    {
        id: 3,
        type: 'NEW_STAFF',
        message: 'New Lecturer assigned to Mathematics Department',
        time: '1 day ago',
        status: 'INFO'
    },
    {
        id: 4,
        type: 'RESULT_REJECTION',
        message: 'You returned MTH 202 results to HOD for corrections',
        time: '2 days ago',
        status: 'REJECTED'
    }
];

export default function DeanDashboard() {
    return (
        <div className="space-y-6">
            {/* Welcome Section */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Dean's Dashboard</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Overview of Faculty of Science academic activities
                    </p>
                </div>
                <div className="flex gap-2">
                    <Link href="/dean/results">
                        <Button className="bg-[#485550] hover:bg-[#3a4543]">
                            <ClipboardCheck className="mr-2 h-4 w-4" /> Approve Results
                        </Button>
                    </Link>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {stats.map((stat, index) => {
                    const Icon = stat.icon;
                    return (
                        <Card key={index} className="border-[#F4F6F0] hover:shadow-md transition-shadow">
                            <CardContent className="p-6">
                                <div className="flex items-center justify-between space-y-0 pb-2">
                                    <p className="text-sm font-medium text-[#485550]/70">{stat.title}</p>
                                    <div className={`p-2 rounded-full ${stat.bg}`}>
                                        <Icon className={`h-4 w-4 ${stat.color} ${stat.title === 'Senate List' ? 'text-[#C0EB6A]' : ''}`} />
                                    </div>
                                </div>
                                <div className="flex items-end justify-between mt-2">
                                    <div>
                                        <div className="text-2xl font-bold text-[#485550]">{stat.value}</div>
                                        <p className={`text-xs mt-1 ${stat.alert ? 'text-amber-600 font-medium' : 'text-[#485550]/50'}`}>
                                            {stat.change}
                                        </p>
                                    </div>
                                    {stat.alert && <AlertCircle className="h-5 w-5 text-amber-500 animate-pulse" />}
                                </div>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Main Chart/Overview Area - Placeholder for now */}
                <div className="lg:col-span-2 space-y-6">
                    <Card className="border-[#F4F6F0] h-full">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Academic Performance Trend</CardTitle>
                            <CardDescription>Average GP comparison across departments</CardDescription>
                        </CardHeader>
                        <CardContent className="flex items-center justify-center h-[300px] bg-[#F4F6F0]/30 rounded-lg m-6 border border-dashed border-[#485550]/20">
                            <div className="text-center">
                                <TrendingUp className="h-10 w-10 text-[#485550]/40 mx-auto mb-3" />
                                <p className="text-[#485550]/60">Performance charts will appear here once results are processed</p>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Recent Activity */}
                <div className="lg:col-span-1">
                    <Card className="border-[#F4F6F0] h-full">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Recent Activity</CardTitle>
                            <CardDescription>Latest updates from your faculty</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-4">
                                {recentActivity.map((activity) => (
                                    <div key={activity.id} className="flex gap-4 pb-4 border-b border-[#F4F6F0] last:border-0 last:pb-0">
                                        <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${activity.status === 'PENDING' ? 'bg-amber-500' :
                                                activity.status === 'APPROVED' ? 'bg-[#C0EB6A]' :
                                                    activity.status === 'REJECTED' ? 'bg-red-500' : 'bg-blue-500'
                                            }`} />
                                        <div className="space-y-1">
                                            <p className="text-sm font-medium text-[#485550] leading-tight">
                                                {activity.message}
                                            </p>
                                            <div className="flex items-center gap-2">
                                                <Clock className="h-3 w-3 text-[#485550]/40" />
                                                <span className="text-xs text-[#485550]/50">{activity.time}</span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <Button variant="ghost" className="w-full mt-4 text-[#485550] hover:text-[#485550]/80 hover:bg-[#F4F6F0]">
                                View All Activity <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
