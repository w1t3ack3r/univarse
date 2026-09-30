'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
    LayoutDashboard,
    Building2,
    Monitor,
    Shield,
    CreditCard,
    Settings,
    FileText,
    Search,
    PlusCircle,
    X,
    Move
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from '@/components/ui/command';

export function CommandPalette() {
    const [open, setOpen] = React.useState(false);
    const router = useRouter();

    React.useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                setOpen((open) => !open);
            }
        };

        document.addEventListener('keydown', down);
        return () => document.removeEventListener('keydown', down);
    }, []);

    // Listen for custom event from layout
    React.useEffect(() => {
        const handleOpen = () => setOpen(true);
        window.addEventListener('open-command-palette', handleOpen);
        return () => window.removeEventListener('open-command-palette', handleOpen);
    }, []);

    const runCommand = React.useCallback((command: () => unknown) => {
        // Optional: Keep open if users want to do multiple actions, but usually closing is better.
        // User asked for "interactive dashboard", so maybe we don't auto-close?
        // Let's close for navigation actions, keep open for toggle.
        setOpen(false);
        command();
    }, []);

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.9, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    transition={{ type: "spring", duration: 0.3, bounce: 0.2 }}
                    drag
                    dragMomentum={false}
                    className="fixed z-50 top-1/4 left-1/2 -translate-x-1/2 shadow-[0_20px_50px_rgba(0,0,0,0.3)] rounded-2xl overflow-hidden backdrop-blur-3xl bg-white/70 border border-white/50 w-[500px]"
                >
                    <Command className="bg-transparent border-none">
                        {/* Drag Handle & Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-[#D1DBC1]/30 cursor-move active:cursor-grabbing bg-white/40">
                            <div className="flex items-center gap-2 text-[#485550]">
                                <div className="p-1 rounded-md bg-[#C0EB6A]/20">
                                    <Search className="w-3.5 h-3.5 text-[#485550]" />
                                </div>
                                <span className="text-xs font-semibold tracking-wide uppercase opacity-70">UniVarse Cmd</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] bg-white/50 px-2 py-0.5 rounded-full text-[#6B7C6F] font-mono border border-black/5">Ctrl + K</span>
                                <button
                                    onClick={() => setOpen(false)}
                                    className="p-1 rounded-full hover:bg-black/5 transition-colors text-[#6B7C6F] hover:text-red-500"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>

                        {/* Input Area */}
                        <div className="px-2">
                            <CommandInput
                                placeholder="What would you like to do?"
                                className="border-none focus:ring-0 text-[#485550] placeholder:text-[#6B7C6F]/70 h-12 text-sm font-medium bg-transparent"
                            />
                        </div>

                        {/* Compact List */}
                        <CommandList className="max-h-[320px] overflow-y-auto p-2 scrollbar-thumb-gray-200 scrollbar-track-transparent scrollbar-thin">
                            <CommandEmpty className="py-8 text-center text-[#6B7C6F] text-sm">
                                No matching commands found.
                            </CommandEmpty>

                            <CommandGroup heading="Suggestions" className="text-[#6B7C6F] font-medium [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider">
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <LayoutDashboard className="mr-2 h-4 w-4 opacity-70" />
                                    <span>Dashboard</span>
                                </CommandItem>
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/institutions'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <Building2 className="mr-2 h-4 w-4 opacity-70" />
                                    <span>Institutions</span>
                                </CommandItem>
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/monitoring'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <Monitor className="mr-2 h-4 w-4 opacity-70" />
                                    <span>System Health</span>
                                </CommandItem>
                            </CommandGroup>

                            <CommandSeparator className="bg-[#D1DBC1]/30 my-2" />

                            <CommandGroup heading="Quick Actions" className="text-[#6B7C6F] font-medium text-xs">
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/institutions?action=create'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <PlusCircle className="mr-2 h-4 w-4 opacity-70" />
                                    <span>New Institution</span>
                                </CommandItem>
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/settings/security'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <Shield className="mr-2 h-4 w-4 opacity-70" />
                                    <span>Security Settings</span>
                                </CommandItem>
                            </CommandGroup>

                            <CommandSeparator className="bg-[#D1DBC1]/30 my-2" />

                            <CommandGroup heading="Institutions" className="text-[#6B7C6F] font-medium text-xs">
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/institutions/1'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <div className="w-2 h-2 rounded-full bg-blue-500 mr-3" />
                                    <span>Universal Tech</span>
                                    <CommandShortcut className="text-[10px] text-[#6B7C6F] bg-white/50 px-1 rounded">UNIV</CommandShortcut>
                                </CommandItem>
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/institutions/2'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <div className="w-2 h-2 rounded-full bg-purple-500 mr-3" />
                                    <span>Cyber Academy</span>
                                    <CommandShortcut className="text-[10px] text-[#6B7C6F] bg-white/50 px-1 rounded">CYBER</CommandShortcut>
                                </CommandItem>
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/institutions/3'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <div className="w-2 h-2 rounded-full bg-amber-500 mr-3" />
                                    <span>NextGen Learning</span>
                                    <CommandShortcut className="text-[10px] text-[#6B7C6F] bg-white/50 px-1 rounded">NEXT</CommandShortcut>
                                </CommandItem>
                            </CommandGroup>

                            <CommandSeparator className="bg-[#D1DBC1]/30 my-2" />

                            <CommandGroup heading="System" className="text-[#6B7C6F] font-medium text-xs">
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/settings'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <Settings className="mr-2 h-4 w-4 opacity-70" />
                                    <span>Settings</span>
                                </CommandItem>
                                <CommandItem onSelect={() => runCommand(() => router.push('/super-admin/audit-logs'))} className="rounded-lg aria-selected:bg-[#C0EB6A]/30 aria-selected:text-[#485550] py-2">
                                    <FileText className="mr-2 h-4 w-4 opacity-70" />
                                    <span>Audit Logs</span>
                                </CommandItem>
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
