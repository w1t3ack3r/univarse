'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
    Users,
    GraduationCap,
    BookOpen,
    Calendar,
    TrendingUp,
    AlertCircle,
    CheckCircle,
    Clock,
    Bell,
    Filter,
    Loader2,
    UserPlus,
    Building2,
} from 'lucide-react';

interface DashboardStats {
    users: { total: number; students: number; lecturers: number; admins: number };
    faculties: number;
    departments: number;
    courses: number;
    currentSession: string | null;
}

// Mock faculty distribution data
const mockFacultyData = [
    { name: 'Science', total: 650, level100: 180, level200: 170, level300: 160, level400: 140, bachelor: 580, master: 50, phd: 20 },
    { name: 'Engineering', total: 520, level100: 140, level200: 140, level300: 130, level400: 110, bachelor: 480, master: 30, phd: 10 },
    { name: 'Arts', total: 380, level100: 100, level200: 100, level300: 90, level400: 90, bachelor: 350, master: 25, phd: 5 },
    { name: 'Management', total: 450, level100: 120, level200: 120, level300: 110, level400: 100, bachelor: 400, master: 40, phd: 10 },
    { name: 'Medicine', total: 280, level100: 70, level200: 70, level300: 70, level400: 70, bachelor: 250, master: 20, phd: 10 },
];

// Mock recent activities
const mockActivities = [
    { id: 1, action: 'New Student enrolled', user: 'John Doe', time: '10:30 AM', status: 'success' },
    { id: 2, action: 'Course created', user: 'Dr. Adewale', time: '09:15 AM', status: 'success' },
    { id: 3, action: 'Department updated', user: 'Admin', time: '08:45 AM', status: 'info' },
    { id: 4, action: 'User account activated', user: 'System', time: '08:00 AM', status: 'success' },
    { id: 5, action: 'Session schedule published', user: 'Admin', time: '07:30 AM', status: 'info' },
];

export default function ITAdminDashboard() {
    const [selectedLevel, setSelectedLevel] = useState('all');
    const [selectedDegree, setSelectedDegree] = useState('all');
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [adminName, setAdminName] = useState('Admin');
    const [institutionName, setInstitutionName] = useState('your institution');
    const router = useRouter();

    useEffect(() => {
        const checkAuthAndFetch = () => {
            const user = api.getCurrentUser();
            if (user) {
                setAdminName(user.firstName);
            }

            if (api.isAuthenticated()) {
                fetchDashboardStats();
            } else {
                // Use mock data when not authenticated
                setStats({
                    users: { total: 2606, students: 2280, lecturers: 256, admins: 70 },
                    faculties: 8,
                    departments: 42,
                    courses: 186,
                    currentSession: '2024/2025 (Demo)'
                });
                setLoading(false);
            }
        };

        checkAuthAndFetch();
    }, []);

    const fetchDashboardStats = async () => {
        setLoading(true);
        try {
            const data = await api.getAdminDashboardStats();
            setStats(data);
        } catch (err: any) {
            console.error('Failed to fetch dashboard stats:', err);
            setStats({
                users: { total: 2606, students: 2280, lecturers: 256, admins: 70 },
                faculties: 8,
                departments: 42,
                courses: 186,
                currentSession: '2024/2025'
            });
        } finally {
            setLoading(false);
        }
    };

    // Filter chart data based on selected level and degree
    const getFilteredData = () => {
        return mockFacultyData.map(dept => {
            let value = dept.total;
            let label = 'Total Students';

            if (selectedLevel !== 'all') {
                switch (selectedLevel) {
                    case '100':
                        value = dept.level100;
                        label = '100Lvl Students';
                        break;
                    case '200':
                        value = dept.level200;
                        label = '200Lvl Students';
                        break;
                    case '300':
                        value = dept.level300;
                        label = '300Lvl Students';
                        break;
                    case '400':
                        value = dept.level400;
                        label = '400Lvl Students';
                        break;
                }
            }

            if (selectedDegree !== 'all') {
                switch (selectedDegree) {
                    case 'bachelor':
                        value = selectedLevel !== 'all' ? Math.floor(dept.bachelor * 0.25) : dept.bachelor;
                        label = selectedLevel !== 'all' ? `Bachelor Level ${selectedLevel}` : 'Bachelor Students';
                        break;
                    case 'master':
                        value = selectedLevel !== 'all' ? Math.floor(dept.master * 0.5) : dept.master;
                        label = selectedLevel !== 'all' ? `Master Level ${selectedLevel}` : 'Master Students';
                        break;
                    case 'phd':
                        value = selectedLevel !== 'all' ? Math.floor(dept.phd * 0.33) : dept.phd;
                        label = selectedLevel !== 'all' ? `PhD Level ${selectedLevel}` : 'PhD Students';
                        break;
                }
            }

            return { name: dept.name, students: value, label };
        });
    };

    const chartData = getFilteredData();

    const statCards = stats ? [
        {
            title: 'Total Students',
            value: stats.users.students.toLocaleString(),
            icon: Users,
            color: 'text-[#485550]',
            bgColor: 'bg-[#F4F6F0]'
        },
        {
            title: 'Lecturers',
            value: stats.users.lecturers.toLocaleString(),
            icon: GraduationCap,
            color: 'text-[#485550]',
            bgColor: 'bg-[#C0EB6A]/20'
        },
        {
            title: 'Faculties',
            value: stats.faculties.toLocaleString(),
            icon: Building2,
            color: 'text-[#485550]',
            bgColor: 'bg-[#F4F6F0]'
        },
        {
            title: 'Departments',
            value: stats.departments.toLocaleString(),
            icon: BookOpen,
            color: 'text-[#485550]',
            bgColor: 'bg-[#C0EB6A]/20'
        }
    ] : [];

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-[#485550]" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Welcome Section */}
            <div className="bg-gradient-to-r from-[#485550] to-[#6b7c6f] rounded-xl p-6 text-white shadow-lg">
                <h2 className="text-2xl font-bold m-0 p-0">Welcome back, {adminName}</h2>
                <p className="text-[#C0EB6A] m-0 p-0 mt-1">
                    {stats?.currentSession
                        ? `Current Session: ${stats.currentSession}`
                        : `Here's what's happening in ${institutionName} today.`}
                </p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {statCards.map((stat, index) => {
                    const Icon = stat.icon;
                    return (
                        <Card key={index} className="hover:shadow-lg transition-all duration-300 border-[#F4F6F0] hover:border-[#C0EB6A]">
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">
                                    {stat.title}
                                </CardTitle>
                                <div className={`p-2 rounded-full ${stat.bgColor}`}>
                                    <Icon className={`h-4 w-4 ${stat.color}`} />
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold text-[#485550]">{stat.value}</div>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Recent Activities */}
                <Card className="border-[#F4F6F0]">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-[#C0EB6A]/20">
                                <TrendingUp className="h-5 w-5 text-[#485550]" />
                            </div>
                            <div>
                                <div className="text-[#485550]">Recent Activities</div>
                                <p className="font-normal text-sm text-muted-foreground">Latest system activities and updates</p>
                            </div>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {mockActivities.map((activity) => (
                                <div key={activity.id} className="flex items-start space-x-3 p-3 rounded-lg bg-[#F4F6F0]/50 hover:bg-[#F4F6F0] transition-colors">
                                    <div className="flex-shrink-0 mt-1">
                                        {activity.status === 'success' && <CheckCircle className="h-4 w-4 text-[#C0EB6A]" />}
                                        {activity.status === 'warning' && <AlertCircle className="h-4 w-4 text-yellow-500" />}
                                        {activity.status === 'info' && <Clock className="h-4 w-4 text-[#485550]" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-[#485550]">{activity.action}</p>
                                        <p className="text-sm text-muted-foreground">{activity.user}</p>
                                        <p className="text-xs text-muted-foreground">{activity.time}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <Button variant="outline" className="w-full mt-4 border-[#485550] text-[#485550] hover:bg-[#485550] hover:text-white">
                            View All Activities
                        </Button>
                    </CardContent>
                </Card>

                {/* Faculty Overview with Bar Chart */}
                <Card className="border-[#F4F6F0]">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-[#C0EB6A]/20">
                                <TrendingUp className="h-5 w-5 text-[#485550]" />
                            </div>
                            <div>
                                <div className="text-[#485550]">Faculty Overview</div>
                                <p className="font-normal text-sm text-muted-foreground">Top 5 Faculties by Student Count</p>
                            </div>
                        </CardTitle>
                        {/* Filters */}
                        <div className="flex items-center flex-wrap gap-3 pt-4">
                            <div className="flex items-center gap-2">
                                <Filter className="h-4 w-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-[#485550]">Filters:</span>
                            </div>

                            <Select value={selectedLevel} onValueChange={setSelectedLevel}>
                                <SelectTrigger className="w-32 border-[#485550]/20 focus:ring-[#C0EB6A]">
                                    <SelectValue placeholder="Level" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Levels</SelectItem>
                                    <SelectItem value="100">Level 100</SelectItem>
                                    <SelectItem value="200">Level 200</SelectItem>
                                    <SelectItem value="300">Level 300</SelectItem>
                                    <SelectItem value="400">Level 400</SelectItem>
                                </SelectContent>
                            </Select>

                            <Select value={selectedDegree} onValueChange={setSelectedDegree}>
                                <SelectTrigger className="w-32 border-[#485550]/20 focus:ring-[#C0EB6A]">
                                    <SelectValue placeholder="Degree" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Degrees</SelectItem>
                                    <SelectItem value="bachelor">Bachelor</SelectItem>
                                    <SelectItem value="master">Master</SelectItem>
                                    <SelectItem value="phd">PhD</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="h-72">
                            {chartData.every(dept => dept.students === 0) ? (
                                <div className="flex items-center justify-center h-full text-muted-foreground">
                                    No data available for this filter
                                </div>
                            ) : (
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={chartData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#F4F6F0" />
                                        <XAxis
                                            dataKey="name"
                                            angle={0}
                                            textAnchor="middle"
                                            height={60}
                                            fontSize={12}
                                            tick={{ fill: '#485550' }}
                                        />
                                        <YAxis tick={{ fill: '#485550' }} />
                                        <Tooltip
                                            formatter={(value: any, name: any, props: any) => [value, props.payload.label || 'Students']}
                                            contentStyle={{
                                                backgroundColor: '#FFFFFF',
                                                border: '1px solid #F4F6F0',
                                                borderRadius: '8px',
                                                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                                            }}
                                            labelStyle={{ color: '#485550', fontWeight: 600 }}
                                        />
                                        <Bar
                                            dataKey="students"
                                            fill="#C0EB6A"
                                            radius={[8, 8, 0, 0]}
                                            stroke="#485550"
                                            strokeWidth={1}
                                        />
                                    </BarChart>
                                </ResponsiveContainer>
                            )}
                        </div>
                        {/* Summary Stats */}
                        <div className="mt-4 pt-4 border-t border-[#F4F6F0]">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-muted-foreground">
                                    Showing: {chartData[0]?.label || 'Total Students'}
                                </span>
                                <Badge className="bg-[#485550] text-white border-0 hover:bg-[#6b7c6f]">
                                    Total: {chartData.reduce((sum, dept) => sum + dept.students, 0).toLocaleString()} students
                                </Badge>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Quick Actions */}
            <Card className="border-[#F4F6F0]">
                <CardHeader>
                    <CardTitle className="text-[#485550]">Quick Actions</CardTitle>
                    <CardDescription>Common administrative tasks</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <Button
                            className="h-20 flex-col space-y-2 bg-[#485550] hover:bg-[#6b7c6f] text-white"
                            onClick={() => router.push('/it-admin/users')}
                        >
                            <UserPlus className="h-6 w-6" />
                            <span>Onboard User</span>
                        </Button>
                        <Button
                            variant="outline"
                            className="h-20 flex-col space-y-2 border-[#485550] text-[#485550] hover:bg-[#C0EB6A]/20"
                            onClick={() => router.push('/it-admin/courses')}
                        >
                            <BookOpen className="h-6 w-6" />
                            <span>Manage Courses</span>
                        </Button>
                        <Button
                            variant="outline"
                            className="h-20 flex-col space-y-2 border-[#485550] text-[#485550] hover:bg-[#C0EB6A]/20"
                            onClick={() => router.push('/it-admin/structure')}
                        >
                            <Building2 className="h-6 w-6" />
                            <span>Academic Structure</span>
                        </Button>
                        <Button
                            variant="outline"
                            className="h-20 flex-col space-y-2 border-[#485550] text-[#485550] hover:bg-[#C0EB6A]/20"
                            onClick={() => router.push('/it-admin/notifications')}
                        >
                            <Bell className="h-6 w-6" />
                            <span>Send Notification</span>
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
