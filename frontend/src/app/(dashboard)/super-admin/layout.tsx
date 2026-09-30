'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    TooltipProvider,
} from "@/components/ui/tooltip";
import {
    LayoutDashboard,
    Building2,
    Database,
    Users,
    Shield,
    FileText,
    Activity,
    Settings,
    Menu,
    LogOut,
    ChevronLeft,
    ChevronRight,
    Crown,
    Server,
    Bell,
    Search,
    UserCircle,
    TrendingUp,
    MessageSquare,
    CreditCard,
    Folder,
    Megaphone
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { CommandPalette } from '@/components/super-admin/CommandPalette';

// Navigation items
const navigation = [
    { name: 'Dashboard', href: '/super-admin', icon: LayoutDashboard },
    { name: 'Institutions', href: '/super-admin/institutions', icon: Building2 },
    { name: 'Provisioning', href: '/super-admin/provisioning', icon: Database },
    { name: 'Super Admins', href: '/super-admin/admins', icon: Shield },

    { name: 'Billing & Plans', href: '/super-admin/billing', icon: CreditCard },
    { name: 'Resources', href: '/super-admin/resources', icon: Folder },
    { name: 'Audit Logs', href: '/super-admin/audit-logs', icon: FileText },
    { name: 'Analytics', href: '/super-admin/analytics', icon: TrendingUp },
    { name: 'Monitoring', href: '/super-admin/monitoring', icon: Activity },
    { name: 'Broadcasts', href: '/super-admin/broadcast', icon: Megaphone },
    { name: 'Support', href: '/super-admin/support', icon: MessageSquare },
    { name: 'Settings', href: '/super-admin/settings', icon: Settings },
];

export default function SuperAdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [admin, setAdmin] = useState<{ email: string; firstName?: string; lastName?: string; name?: string } | null>(null);
    const pathname = usePathname();
    const router = useRouter();

    useEffect(() => {
        // Check for super admin authentication
        const adminData = localStorage.getItem('superAdmin');
        if (adminData) {
            setAdmin(JSON.parse(adminData));
        }
    }, []);

    const handleLogout = () => {
        localStorage.removeItem('superAdminToken');
        localStorage.removeItem('superAdmin');
        router.push('/super-admin/login');
    };

    const isActive = (href: string) => {
        if (href === '/super-admin') {
            return pathname === '/super-admin';
        }
        return pathname.startsWith(href);
    };

    const getAdminInitials = () => {
        if (admin) {
            if (admin.firstName && admin.lastName) {
                return `${admin.firstName[0]}${admin.lastName[0]}`.toUpperCase();
            }
            if (admin.name) {
                const parts = admin.name.split(' ');
                if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
                return parts[0].substring(0, 2).toUpperCase();
            }
        }
        return 'SA';
    };

    // Navigation Link Component
    const NavLink = ({ item, mobile = false }: { item: typeof navigation[0], mobile?: boolean }) => {
        const Icon = item.icon;
        const active = isActive(item.href);

        return (
            <TooltipProvider delayDuration={100}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Link
                            href={item.href}
                            onClick={() => mobile && setSidebarOpen(false)}
                            className={`flex items-center gap-3 px-5 py-5 rounded-2xl transition-all duration-300 group relative overflow-hidden
                                ${active
                                    ? 'bg-[#C0EB6A] text-[#485550] shadow-[4px_4px_10px_#333b38,-4px_-4px_10px_#5d6f68]'
                                    : 'text-[#E8EDE0] hover:bg-[#FFFFFF]/10 hover:text-white'
                                }
                                ${collapsed && !mobile ? 'justify-center px-0 w-12 h-12' : ''}
                            `}
                        >
                            {/* Active Indicator Glow for Collapsed */}
                            {active && collapsed && !mobile && (
                                <div className="absolute inset-0 bg-[#C0EB6A] blur-md opacity-40"></div>
                            )}

                            <Icon className={`h-5 w-5 shrink-0 z-10 transition-transform duration-300 ${active ? 'scale-110' : 'group-hover:scale-110'}`} />

                            {(!collapsed || mobile) && (
                                <span className="text-sm font-semibold z-10 transition-all duration-300">
                                    {item.name}
                                </span>
                            )}
                        </Link>
                    </TooltipTrigger>
                    {collapsed && !mobile && (
                        <TooltipContent side="right" className="bg-[#485550] text-white border-[#C0EB6A]/20 px-3 py-2 rounded-xl shadow-xl ml-2 font-medium">
                            {item.name}
                        </TooltipContent>
                    )}
                </Tooltip>
            </TooltipProvider>
        );
    };

    // Sidebar Content
    const SidebarContent = ({ mobile = false }: { mobile?: boolean }) => (
        <div
            className={`flex h-full flex-col bg-gradient-to-b from-[#485550] to-[#2A302D] transition-all duration-500 ease-in-out relative
                ${mobile ? 'w-72' : collapsed ? 'w-[5.5rem]' : 'w-72'}
                ${!mobile && 'shadow-[10px_0_30px_rgba(0,0,0,0.1)] border-r border-[#FFFFFF]/10'}
            `}
        >
            {/* Logo Area */}
            <div className={`flex h-24 shrink-0 items-center justify-between px-6 ${collapsed && !mobile ? 'justify-center px-0' : ''}`}>
                {!collapsed && (
                    <div className="flex items-center gap-3 animate-in fade-in slide-in-from-left-4 duration-500">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#C0EB6A] to-[#84cc16] flex items-center justify-center shadow-lg transform rotate-3 group hover:rotate-0 transition-all duration-300">
                            <Crown className="w-6 h-6 text-[#485550]" />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xl font-bold text-white tracking-tight">UniVarse</span>
                            <span className="text-[10px] text-[#C0EB6A] font-medium tracking-wider uppercase">Super Admin</span>
                        </div>
                    </div>
                )}
                {collapsed && !mobile && (
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#C0EB6A] to-[#84cc16] flex items-center justify-center shadow-lg">
                        <Crown className="w-6 h-6 text-[#485550]" />
                    </div>
                )}

                {/* Collapse Toggle (Desktop) */}
                {!mobile && !collapsed && (
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCollapsed(!collapsed)}
                        className="text-[#E8EDE0] hover:text-[#C0EB6A] hover:bg-[#FFFFFF]/10 h-8 w-8 rounded-full"
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                )}
            </div>

            {/* Expand button when collapsed */}
            {!mobile && collapsed && (
                <div className="w-full flex justify-center mb-4">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCollapsed(false)}
                        className="text-[#E8EDE0] hover:text-[#C0EB6A] hover:bg-[#FFFFFF]/10 h-8 w-8 rounded-full"
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}

            {/* Search (Optional - Collapsed hidden) */}
            {!collapsed && (
                <div className="px-5 mb-6 animate-in fade-in slide-in-from-top-2 duration-500 delay-100">
                    <div className="relative group" onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}>
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#C0EB6A]/70 group-hover:text-[#C0EB6A] transition-colors" />
                        <Input
                            placeholder="Quick cmd (Ctrl+K)..."
                            readOnly
                            className="bg-[#FFFFFF]/5 border-[#FFFFFF]/10 text-white placeholder:text-[#FFFFFF]/30 pl-9 rounded-xl focus:bg-[#FFFFFF]/10 focus:border-[#C0EB6A]/50 transition-all cursor-pointer"
                        />
                    </div>
                </div>
            )}

            {/* Navigation */}
            <nav className="flex flex-1 flex-col px-4 py-4 space-y-4 overflow-y-auto scrollbar-none">
                {navigation.map((item) => (
                    <NavLink key={item.name} item={item} mobile={mobile} />
                ))}
            </nav>

            {/* Platform Status Badge */}
            {!collapsed && (
                <div className="px-6 py-4 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
                    <div className="flex items-center gap-3 px-4 py-3 bg-[#FFFFFF]/5 rounded-2xl border border-[#FFFFFF]/10 backdrop-blur-sm">
                        <div className="relative">
                            <div className="w-2.5 h-2.5 bg-[#C0EB6A] rounded-full animate-pulse"></div>
                            <div className="absolute inset-0 bg-[#C0EB6A] rounded-full animate-ping opacity-20"></div>
                        </div>
                        <div>
                            <p className="text-xs text-[#E8EDE0] font-medium leading-none mb-1">System Status</p>
                            <p className="text-[10px] text-[#C0EB6A] font-bold tracking-wide">OPERATIONAL</p>
                        </div>
                    </div>
                </div>
            )}

            {/* User Profile Section */}
            <div className="p-4 mt-auto border-t border-[#FFFFFF]/10">
                {!collapsed ? (
                    <div className="flex items-center justify-between gap-2 p-2 rounded-2xl bg-[#FFFFFF]/5 hover:bg-[#FFFFFF]/10 transition-colors group animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <Link href="/super-admin/settings/profile" className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#C0EB6A] to-[#84cc16] flex items-center justify-center text-[#485550] font-bold shadow-md">
                                {getAdminInitials()}
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-sm font-semibold text-white truncate group-hover:text-[#C0EB6A] transition-colors">
                                    {admin ? (admin.firstName && admin.lastName ? `${admin.firstName} ${admin.lastName}` : admin.name) : 'Super Admin'}
                                </span>
                                <span className="text-[10px] text-[#E8EDE0]/60 truncate">{admin?.email || 'admin@univarse.com'}</span>
                            </div>
                        </Link>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleLogout}
                            className="text-[#E8EDE0]/50 hover:text-red-400 hover:bg-red-500/10 h-8 w-8 rounded-lg shrink-0"
                        >
                            <LogOut className="h-4 w-4" />
                        </Button>
                    </div>
                ) : (
                    <div className="flex justify-center">
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Link href="/super-admin/settings/profile">
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#C0EB6A] to-[#84cc16] flex items-center justify-center text-[#485550] font-bold shadow-md cursor-pointer hover:scale-105 transition-transform">
                                            {getAdminInitials()}
                                        </div>
                                    </Link>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="bg-[#485550] text-[#E8EDE0] border-[#FFFFFF]/10">
                                    <p className="font-bold">{admin ? (admin.firstName && admin.lastName ? `${admin.firstName} ${admin.lastName}` : admin.name) : 'Super Admin'}</p>
                                    <p className="text-xs opacity-70 mb-2">{admin?.email || 'admin@univarse.com'}</p>
                                    <div className="text-xs text-red-400 flex items-center gap-1">
                                        <LogOut className="w-3 h-3" /> Click to Logout
                                    </div>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-[#F4F6F0] flex overflow-hidden">
            {/* Mobile sidebar */}
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
                <SheetContent side="left" className="p-0 w-72 border-0 shadow-2xl">
                    <SidebarContent mobile />
                </SheetContent>
            </Sheet>

            {/* Desktop sidebar */}
            <div className={`hidden md:flex flex-col fixed inset-y-0 z-50 transition-all duration-500 ease-in-out ${collapsed ? 'w-[5.5rem]' : 'w-72'}`}>
                <SidebarContent />
            </div>

            {/* Main content */}
            <main className={`flex-1 h-screen overflow-y-auto scrollbar-thin transition-all duration-500 ease-in-out relative ${collapsed ? 'md:ml-[5.5rem]' : 'md:ml-72'}`}>

                {/* Mobile Header */}
                <div className="md:hidden sticky top-0 z-40 bg-[#F4F6F0]/80 backdrop-blur-md border-b border-[#D1DBC1] flex items-center px-4 h-16 justify-between">
                    <div className="flex items-center gap-3">
                        <Button variant="ghost" size="icon" className="text-[#485550]" onClick={() => setSidebarOpen(true)}>
                            <Menu className="w-6 h-6" />
                        </Button>
                        <span className="font-bold text-[#485550] text-lg">UniVarse</span>
                    </div>
                    <div className="w-8 h-8 rounded-full bg-[#C0EB6A] flex items-center justify-center text-[#485550] font-bold text-xs">
                        {getAdminInitials()}
                    </div>
                </div>

                {/* Top Desktop Float Header */}
                <div className="hidden md:flex sticky top-0 z-40 bg-[#F4F6F0]/80 backdrop-blur-md border-b border-[#D1DBC1]/50 items-center justify-between px-8 py-4 mb-6 transition-all duration-300">
                    <div className="flex flex-col">
                        <p className="text-2xl font-bold text-[#485550] capitalize">
                            Welcome back, {admin ? (admin.firstName || admin.name?.split(' ')[0]) : 'Admin'}
                        </p>
                    </div>

                    <div className="flex items-center gap-4">
                        <div className="h-10 w-10 rounded-full bg-white shadow-sm border border-[#D1DBC1] flex items-center justify-center text-[#485550] hover:text-[#C0EB6A] hover:bg-[#485550] transition-colors cursor-pointer group">
                            <Bell className="w-5 h-5 group-hover:animate-swing" />
                        </div>
                        <div className="h-10 px-4 rounded-full bg-white shadow-sm border border-[#D1DBC1] flex items-center gap-2 text-sm font-medium text-[#485550]">
                            <UserCircle className="w-5 h-5 text-[#C0EB6A]" />
                            <span>Support Mode</span>
                        </div>
                    </div>
                </div>

                {/* Page Content Area (Removing overflow/scroll here as main is now the scroller) */}
                <div className="flex-1 px-4 md:px-8 pb-8">
                    <div className="max-w-[1600px] mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
                        {children}
                    </div>
                </div>
            </main>
            <CommandPalette />
        </div>
    );
}
