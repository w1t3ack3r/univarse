'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    TooltipProvider,
} from "@/components/ui/tooltip";
import {
    LayoutDashboard,
    Users,
    GraduationCap,
    BookOpen,
    Library,
    Calendar,
    Bell,
    HelpCircle,
    Settings,
    Menu,
    LogOut,
    ChevronLeft,
    ChevronRight,
    Building2,
    Sparkles,
    Search,
    ClipboardList,
    Wallet,
    CalendarDays,
    ClipboardCheck,
    Award,
    Building,
} from 'lucide-react';
import { api } from '@/lib/api';
import { filterNavByRole, ITAdminRole, getRoleDisplayName } from '@/lib/permissions';

// Navigation items grouped by category
const mainNavigation = [
    { name: 'Dashboard', href: '/it-admin', icon: LayoutDashboard },
    { name: 'User Management', href: '/it-admin/users', icon: Users },
];

const academicNavigation = [
    { name: 'Academic Structure', href: '/it-admin/structure', icon: Building2 },
    { name: 'Course Management', href: '/it-admin/courses', icon: Library },
    { name: 'Programmes', href: '/it-admin/programmes', icon: BookOpen },
    { name: 'Academic Sessions', href: '/it-admin/sessions', icon: Calendar },
    { name: 'Admissions', href: '/it-admin/admissions', icon: ClipboardList },
    { name: 'Fee Management', href: '/it-admin/fees', icon: Wallet },
    { name: 'Examinations', href: '/it-admin/examinations', icon: CalendarDays },
    { name: 'Results', href: '/it-admin/results', icon: ClipboardCheck },
    { name: 'Clearance', href: '/it-admin/clearance', icon: Award },
    { name: 'Hostel', href: '/it-admin/hostel', icon: Building },
];

const systemNavigation = [
    { name: 'Notifications', href: '/it-admin/notifications', icon: Bell },
    { name: 'Support Center', href: '/it-admin/support', icon: HelpCircle },
    { name: 'Settings', href: '/it-admin/settings', icon: Settings },
];

export default function ITAdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [user, setUser] = useState<any>(null);
    const pathname = usePathname();
    const router = useRouter();

    useEffect(() => {
        const currentUser = api.getCurrentUser();
        if (currentUser) {
            setUser(currentUser);
        }
    }, []);

    const handleLogout = async () => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        router.push('/login');
    };

    const isActive = (href: string) => {
        if (href === '/it-admin') {
            return pathname === '/it-admin';
        }
        return pathname.startsWith(href);
    };

    const getUserInitials = () => {
        if (user) {
            return `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase();
        }
        return 'AD';
    };

    const getUserFullName = () => {
        if (user) {
            return `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Admin User';
        }
        return 'Admin User';
    };

    // Get user's IT Admin role (default to CENTRAL for demo, or null if not set)
    const userRole: ITAdminRole = user?.itAdminRole || 'IT_ADMIN_CENTRAL';

    // Filter navigation based on user's role
    const filteredMainNav = filterNavByRole(mainNavigation, userRole);
    const filteredAcademicNav = filterNavByRole(academicNavigation, userRole);
    const filteredSystemNav = filterNavByRole(systemNavigation, userRole);

    // Navigation Link Component
    const NavLink = ({ item, mobile = false }: { item: typeof mainNavigation[0], mobile?: boolean }) => {
        const Icon = item.icon;
        const active = isActive(item.href);

        return (
            <TooltipProvider delayDuration={100}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Link
                            href={item.href}
                            className={`group flex items-center rounded-xl text-sm font-medium transition-all duration-200 ${collapsed && !mobile
                                ? 'h-11 w-11 justify-center'
                                : 'px-3 py-2.5 w-full'
                                } ${active
                                    ? 'bg-[#C0EB6A] text-[#485550] shadow-sm'
                                    : 'text-white/80 hover:bg-white/10 hover:text-white'
                                }`}
                            onClick={() => setSidebarOpen(false)}
                        >
                            <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-[#485550]' : ''}`} />
                            {(!collapsed || mobile) && (
                                <span className="ml-3">{item.name}</span>
                            )}
                        </Link>
                    </TooltipTrigger>
                    {collapsed && !mobile && (
                        <TooltipContent side="right" className="bg-[#485550] text-white border-0 px-3 py-2 rounded-lg shadow-xl">
                            {item.name}
                        </TooltipContent>
                    )}
                </Tooltip>
            </TooltipProvider>
        );
    };

    // Navigation Group Component
    const NavGroup = ({ title, items, mobile = false }: { title: string, items: typeof mainNavigation, mobile?: boolean }) => (
        <div className="space-y-1">
            {!collapsed && (
                <p className="px-3 py-2 text-xs font-semibold text-white/50 uppercase tracking-wider">
                    {title}
                </p>
            )}
            {collapsed && !mobile && <div className="h-px bg-white/10 my-2" />}
            {items.map((item) => (
                <NavLink key={item.name} item={item} mobile={mobile} />
            ))}
        </div>
    );

    // Sidebar Content
    const SidebarContent = ({ mobile = false }: { mobile?: boolean }) => (
        <div
            className={`flex h-full flex-col bg-gradient-to-b from-[#485550] to-[#3a4543] transition-all duration-300 ${mobile ? 'w-72' : collapsed ? 'w-[4.5rem] items-center' : 'w-72'
                }`}
        >
            {/* Logo & Collapse Button */}
            <div className={`flex h-16 shrink-0 items-center justify-between px-4 border-b border-white/10 ${collapsed && !mobile ? 'justify-center' : ''}`}>
                {!collapsed && (
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-[#C0EB6A] flex items-center justify-center">
                            <Sparkles className="w-5 h-5 text-[#485550]" />
                        </div>
                        <span className="text-xl font-bold text-white">UniVarse</span>
                    </div>
                )}
                {collapsed && !mobile && (
                    <div className="w-8 h-8 rounded-lg bg-[#C0EB6A] flex items-center justify-center">
                        <Sparkles className="w-5 h-5 text-[#485550]" />
                    </div>
                )}
                {!mobile && !collapsed && (
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCollapsed(!collapsed)}
                        className="text-white/70 hover:text-white hover:bg-white/10 h-8 w-8"
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                )}
            </div>

            {/* Expand button when collapsed */}
            {!mobile && collapsed && (
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setCollapsed(false)}
                    className="text-white/70 hover:text-white hover:bg-white/10 h-8 w-8 mt-2"
                >
                    <ChevronRight className="h-4 w-4" />
                </Button>
            )}

            {/* Search (when expanded) */}
            {!collapsed && (
                <div className="px-3 py-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-white/40" />
                        <input
                            type="text"
                            placeholder="Search..."
                            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-[#C0EB6A] focus:border-[#C0EB6A]"
                        />
                    </div>
                </div>
            )}

            {/* Navigation */}
            <nav className="flex flex-1 flex-col px-3 py-2 overflow-y-auto scrollbar-thin">
                <div className="space-y-4 flex-1">
                    {filteredMainNav.length > 0 && <NavGroup title="Overview" items={filteredMainNav} mobile={mobile} />}
                    {filteredAcademicNav.length > 0 && <NavGroup title="Academic" items={filteredAcademicNav} mobile={mobile} />}
                    {filteredSystemNav.length > 0 && <NavGroup title="System" items={filteredSystemNav} mobile={mobile} />}
                </div>

                {/* Logout Button */}
                <div className="pt-4 border-t border-white/10 mt-4">
                    <TooltipProvider delayDuration={100}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    onClick={handleLogout}
                                    className={`text-white/70 hover:bg-red-500/20 hover:text-red-400 transition-colors ${collapsed && !mobile
                                        ? 'h-11 w-11 justify-center p-0'
                                        : 'w-full justify-start px-3 py-2.5'
                                        }`}
                                >
                                    <LogOut className="h-5 w-5 shrink-0" />
                                    {(!collapsed || mobile) && <span className="ml-3">Logout</span>}
                                </Button>
                            </TooltipTrigger>
                            {collapsed && !mobile && (
                                <TooltipContent side="right" className="bg-red-500 text-white border-0 px-3 py-2 rounded-lg">
                                    Logout
                                </TooltipContent>
                            )}
                        </Tooltip>
                    </TooltipProvider>
                </div>
            </nav>
        </div>
    );

    return (
        <div className="min-h-screen bg-[#F4F6F0]">
            {/* Mobile sidebar */}
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
                <SheetTrigger asChild>
                    <Button
                        variant="ghost"
                        className="fixed top-4 left-4 z-50 md:hidden bg-white shadow-lg hover:shadow-xl"
                        size="icon"
                    >
                        <Menu className="h-5 w-5 text-[#485550]" />
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="p-0 w-72 border-0">
                    <SidebarContent mobile />
                </SheetContent>
            </Sheet>

            {/* Desktop sidebar */}
            <div className="hidden md:fixed md:inset-y-0 md:z-50 md:flex">
                <SidebarContent />
            </div>

            {/* Main content */}
            <div
                className={`transition-all duration-300 min-h-screen ${collapsed ? 'md:pl-[4.5rem]' : 'md:pl-72'
                    }`}
            >
                {/* Header */}
                <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-lg border-b border-[#485550]/10">
                    <div className="px-4 py-3 sm:px-6 lg:px-8">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-4">
                                <div className="md:hidden w-10" /> {/* Spacer for mobile menu button */}
                                <div>
                                    <h2 className="text-lg font-semibold text-[#485550]">
                                        IT Administration Portal
                                    </h2>
                                    <p className="text-xs text-[#485550]/60">
                                        Manage your institution's digital infrastructure
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center space-x-4">
                                {/* Notifications Bell */}
                                <Button variant="ghost" size="icon" className="relative text-[#485550]/70 hover:text-[#485550]">
                                    <Bell className="h-5 w-5" />
                                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[#C0EB6A] rounded-full" />
                                </Button>
                                {/* User Avatar */}
                                <div className="flex items-center gap-3">
                                    <div className="hidden sm:block text-right">
                                        <p className="text-sm font-medium text-[#485550]">{getUserFullName()}</p>
                                        <p className="text-xs text-[#485550]/60">ICT Administrator</p>
                                    </div>
                                    <div className="h-9 w-9 rounded-full bg-[#485550] flex items-center justify-center ring-2 ring-[#C0EB6A] ring-offset-2">
                                        <span className="text-sm font-medium text-white">{getUserInitials()}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </header>

                {/* Main Content Area */}
                <main className="p-4 sm:p-6 lg:p-8">
                    <div className="bg-white rounded-2xl shadow-sm border border-[#485550]/5 p-6 min-h-[calc(100vh-8rem)]">
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}
