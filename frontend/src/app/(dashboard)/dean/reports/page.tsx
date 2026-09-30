'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
    BarChart3,
    TrendingUp,
    Users,
    BookOpen,
    Download,
    Calendar,
    PieChart
} from 'lucide-react';

export default function DeanReports() {
    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Faculty Reports</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Academic performance analytics and faculty insights
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" className="border-[#485550]/20 text-[#485550]">
                        <Calendar className="mr-2 h-4 w-4" /> 2024/2025 Session
                    </Button>
                    <Button className="bg-[#485550] hover:bg-[#3a4543]">
                        <Download className="mr-2 h-4 w-4" /> Export Report
                    </Button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card className="border-[#F4F6F0] bg-[#485550] text-white">
                    <CardContent className="p-6">
                        <div className="flex justify-between items-start">
                            <div>
                                <p className="text-white/70 text-sm font-medium">Avg. Faculty Pass Rate</p>
                                <h3 className="text-3xl font-bold mt-2">86.5%</h3>
                            </div>
                            <TrendingUp className="h-5 w-5 text-[#C0EB6A]" />
                        </div>
                        <p className="text-xs text-[#C0EB6A] mt-2">+2.4% vs last semester</p>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-6">
                        <div className="flex justify-between items-start">
                            <div>
                                <p className="text-[#485550]/70 text-sm font-medium">Total First Class</p>
                                <h3 className="text-3xl font-bold mt-2 text-[#485550]">42</h3>
                            </div>
                            <Users className="h-5 w-5 text-[#485550]/40" />
                        </div>
                        <p className="text-xs text-[#485550]/50 mt-2">Top Dept: Computer Science (12)</p>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-6">
                        <div className="flex justify-between items-start">
                            <div>
                                <p className="text-[#485550]/70 text-sm font-medium">Courses Taught</p>
                                <h3 className="text-3xl font-bold mt-2 text-[#485550]">128</h3>
                            </div>
                            <BookOpen className="h-5 w-5 text-[#485550]/40" />
                        </div>
                        <p className="text-xs text-[#485550]/50 mt-2">All curriculums covered</p>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-6">
                        <div className="flex justify-between items-start">
                            <div>
                                <p className="text-[#485550]/70 text-sm font-medium">Probation List</p>
                                <h3 className="text-3xl font-bold mt-2 text-amber-600">18</h3>
                            </div>
                            <Users className="h-5 w-5 text-amber-500/40" />
                        </div>
                        <p className="text-xs text-[#485550]/50 mt-2">Students below 1.5 CGPA</p>
                    </CardContent>
                </Card>
            </div>

            <Tabs defaultValue="performance" className="space-y-4">
                <TabsList className="bg-[#F4F6F0]">
                    <TabsTrigger value="performance" className="data-[state=active]:bg-white data-[state=active]:text-[#485550]">Performance</TabsTrigger>
                    <TabsTrigger value="demographics" className="data-[state=active]:bg-white data-[state=active]:text-[#485550]">Demographics</TabsTrigger>
                    <TabsTrigger value="attendance" className="data-[state=active]:bg-white data-[state=active]:text-[#485550]">Attendance</TabsTrigger>
                </TabsList>

                <TabsContent value="performance" className="space-y-4">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <Card className="border-[#F4F6F0]">
                            <CardHeader>
                                <CardTitle className="text-[#485550]">Departmental Performance</CardTitle>
                                <CardDescription>Average CGPA per department</CardDescription>
                            </CardHeader>
                            <CardContent className="h-[300px] flex items-center justify-center bg-[#F4F6F0]/30 rounded-lg m-6 border border-dashed border-[#485550]/20">
                                <div className="text-center">
                                    <BarChart3 className="h-10 w-10 text-[#485550]/40 mx-auto mb-3" />
                                    <p className="text-[#485550]/60">Bar Chart: Avg CGPA by Dept</p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="border-[#F4F6F0]">
                            <CardHeader>
                                <CardTitle className="text-[#485550]">Grade Distribution</CardTitle>
                                <CardDescription>Overall grade breakdown (A-F)</CardDescription>
                            </CardHeader>
                            <CardContent className="h-[300px] flex items-center justify-center bg-[#F4F6F0]/30 rounded-lg m-6 border border-dashed border-[#485550]/20">
                                <div className="text-center">
                                    <PieChart className="h-10 w-10 text-[#485550]/40 mx-auto mb-3" />
                                    <p className="text-[#485550]/60">Pie Chart: A, B, C, D, E, F distribution</p>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                <TabsContent value="demographics" className="min-h-[300px] border rounded-lg p-8 flex items-center justify-center bg-[#F4F6F0]/20">
                    <p className="text-[#485550]/60">Student demographic data visualization will appear here.</p>
                </TabsContent>

                <TabsContent value="attendance" className="min-h-[300px] border rounded-lg p-8 flex items-center justify-center bg-[#F4F6F0]/20">
                    <p className="text-[#485550]/60">Attendance statistics will appear here.</p>
                </TabsContent>
            </Tabs>
        </div>
    );
}
