'use client';

import { useState } from 'react';
import {
    Folder,
    FileText,
    Image as ImageIcon,
    Upload,
    MoreVertical,
    Download,
    Trash2,
    Share2,
    Search,
    Grid,
    List as ListIcon,
    Plus,
    FileCode,
    Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

// --- MOCK DATA ---

type FileType = 'FOLDER' | 'PDF' | 'IMAGE' | 'TEMPLATE';

interface ResourceFile {
    id: string;
    name: string;
    type: FileType;
    size?: string;
    items?: number; // for folders
    updatedAt: string;
    distributed: boolean; // items distributed to all tenants
}

const MOCK_FILES: ResourceFile[] = [
    { id: '1', name: 'Global Policies', type: 'FOLDER', items: 4, updatedAt: '2026-01-15', distributed: true },
    { id: '2', name: 'Email Templates', type: 'FOLDER', items: 12, updatedAt: '2026-01-20', distributed: true },
    { id: '3', name: 'Branding Assets', type: 'FOLDER', items: 8, updatedAt: '2026-01-10', distributed: false },
    { id: '4', name: 'Terms_of_Service_v2.pdf', type: 'PDF', size: '2.4 MB', updatedAt: '2026-01-28', distributed: true },
    { id: '5', name: 'Privacy_Policy_Global.pdf', type: 'PDF', size: '1.1 MB', updatedAt: '2026-01-28', distributed: true },
    { id: '6', name: 'Default_Certificate.svg', type: 'IMAGE', size: '450 KB', updatedAt: '2026-01-25', distributed: false },
    { id: '7', name: 'invoice_template.html', type: 'TEMPLATE', size: '82 KB', updatedAt: '2026-01-22', distributed: true },
];

export default function ResourcesPage() {
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [isUploading, setIsUploading] = useState(false);
    const [files, setFiles] = useState(MOCK_FILES);

    const handleUpload = () => {
        setIsUploading(true);
        // Mock upload delay
        setTimeout(() => {
            setIsUploading(false);
            const newFile: ResourceFile = {
                id: Math.random().toString(),
                name: 'New_Upload_' + new Date().getTime() + '.pdf',
                type: 'PDF',
                size: '1.5 MB',
                updatedAt: new Date().toISOString().split('T')[0],
                distributed: false
            };
            setFiles([newFile, ...files]);
            toast.success('File uploaded successfully');
        }, 1500);
    };

    const handlePushToTenants = (fileId: string) => {
        toast.promise(
            new Promise(resolve => setTimeout(resolve, 1000)),
            {
                loading: 'Distributing content to all tenants...',
                success: () => {
                    setFiles(files.map(f => f.id === fileId ? { ...f, distributed: true } : f));
                    return 'Content synchronized across all 12 tenants.';
                },
                error: 'Failed to distribute content.'
            }
        );
    };

    const handleDelete = (fileId: string) => {
        setFiles(files.filter(f => f.id !== fileId));
        toast.success('Resource deleted.');
    };

    // Helper to get Icon
    const getFileIcon = (type: FileType) => {
        switch (type) {
            case 'FOLDER': return <Folder className="w-12 h-12 text-[#C0EB6A]" />;
            case 'PDF': return <FileText className="w-12 h-12 text-red-400" />;
            case 'IMAGE': return <ImageIcon className="w-12 h-12 text-blue-400" />;
            case 'TEMPLATE': return <FileCode className="w-12 h-12 text-purple-400" />;
            default: return <FileText className="w-12 h-12 text-gray-400" />;
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Global Resource Library</h2>
                    <p className="text-[#6B7C6F]">Centralized asset management and distribution.</p>
                </div>
                <div className="flex gap-2">
                    <Button
                        onClick={handleUpload}
                        disabled={isUploading}
                        className="btn-morph-primary"
                    >
                        {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                        {isUploading ? 'Uploading...' : 'Upload Resource'}
                    </Button>
                </div>
            </div>

            {/* Toolbar */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-4 rounded-xl border border-[#F4F6F0] shadow-sm">
                <div className="relative w-full sm:w-96">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input placeholder="Search resources..." className="pl-10 bg-[#F4F6F0] border-transparent focus:bg-white transition-all" />
                </div>
                <div className="flex items-center gap-2">
                    <div className="bg-[#F4F6F0] p-1 rounded-lg flex">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setViewMode('grid')}
                            className={`h-8 w-8 p-0 rounded-md ${viewMode === 'grid' ? 'bg-white shadow-sm text-[#485550]' : 'text-[#6B7C6F]'}`}
                        >
                            <Grid className="w-4 h-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setViewMode('list')}
                            className={`h-8 w-8 p-0 rounded-md ${viewMode === 'list' ? 'bg-white shadow-sm text-[#485550]' : 'text-[#6B7C6F]'}`}
                        >
                            <ListIcon className="w-4 h-4" />
                        </Button>
                    </div>
                    <Button variant="outline" size="icon" className="btn-morph bg-white">
                        <Plus className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            {/* GRID VIEW */}
            {viewMode === 'grid' && (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                    {files.map((file) => (
                        <div key={file.id} className="morph-card p-4 group cursor-pointer hover:border-[#C0EB6A] transition-all relative">
                            {/* Actions Dropdown Placeholder */}
                            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button variant="ghost" size="icon" className="h-6 w-6">
                                    <MoreVertical className="w-4 h-4 text-[#6B7C6F]" />
                                </Button>
                            </div>

                            <div className="flex flex-col items-center text-center pt-2">
                                <div className="mb-4 transform group-hover:scale-105 transition-transform">
                                    {getFileIcon(file.type)}
                                </div>
                                <h3 className="font-bold text-[#485550] text-sm truncate w-full mb-1">{file.name}</h3>
                                <p className="text-xs text-[#6B7C6F] mb-3">
                                    {file.type === 'FOLDER' ? `${file.items} items` : file.size}
                                </p>

                                {file.type !== 'FOLDER' && (
                                    <div className="flex gap-2 w-full mt-2">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="flex-1 h-8 text-xs border-[#D1DBC1]"
                                            onClick={(e) => { e.stopPropagation(); handlePushToTenants(file.id); }}
                                        >
                                            <Share2 className="w-3 h-3 mr-1" />
                                            {file.distributed ? 'Synced' : 'Push'}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}

                    {/* Add New Placeholder */}
                    <div
                        onClick={handleUpload}
                        className="rounded-2xl border-2 border-dashed border-[#D1DBC1] flex flex-col items-center justify-center p-4 min-h-[180px] cursor-pointer hover:bg-[#F4F6F0] hover:border-[#C0EB6A] transition-colors group"
                    >
                        <div className="w-12 h-12 rounded-full bg-[#F4F6F0] flex items-center justify-center mb-3 group-hover:bg-white group-hover:shadow-sm transition-all">
                            <Plus className="w-6 h-6 text-[#6B7C6F] group-hover:text-[#C0EB6A]" />
                        </div>
                        <p className="text-[#6B7C6F] font-bold text-sm">Upload New</p>
                    </div>
                </div>
            )}

            {/* LIST VIEW */}
            {viewMode === 'list' && (
                <div className="morph-card overflow-hidden p-0">
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-[#6B7C6F] uppercase bg-[#F4F6F0]">
                            <tr>
                                <th className="px-6 py-3">Name</th>
                                <th className="px-6 py-3">Type</th>
                                <th className="px-6 py-3">Size/Items</th>
                                <th className="px-6 py-3">Last Updated</th>
                                <th className="px-6 py-3">Status</th>
                                <th className="px-6 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {files.map((file) => (
                                <tr key={file.id} className="bg-white border-b border-[#F4F6F0] hover:bg-[#F4F6F0]/50">
                                    <td className="px-6 py-4 font-bold text-[#485550] flex items-center gap-3">
                                        {getFileIcon(file.type)}
                                        {file.name}
                                    </td>
                                    <td className="px-6 py-4">
                                        <Badge variant="secondary" className="bg-[#F4F6F0] text-[#6B7C6F]">{file.type}</Badge>
                                    </td>
                                    <td className="px-6 py-4 text-[#6B7C6F]">
                                        {file.type === 'FOLDER' ? `${file.items} items` : file.size}
                                    </td>
                                    <td className="px-6 py-4 text-[#6B7C6F]">{file.updatedAt}</td>
                                    <td className="px-6 py-4">
                                        {file.distributed ? (
                                            <span className="flex items-center text-green-600 text-xs font-bold">
                                                <CheckCircle2 className="w-3 h-3 mr-1" /> Synced
                                            </span>
                                        ) : (
                                            <span className="flex items-center text-gray-400 text-xs">
                                                Local Only
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            {file.distributed ? (
                                                <Button variant="ghost" size="icon" className="h-8 w-8 text-green-600 bg-green-50">
                                                    <Share2 className="w-4 h-4" />
                                                </Button>
                                            ) : (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-8"
                                                    onClick={() => handlePushToTenants(file.id)}
                                                >
                                                    Push
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-gray-400 hover:text-red-500"
                                                onClick={() => handleDelete(file.id)}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function CheckCircle2({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <circle cx="12" cy="12" r="10" />
            <path d="m9 12 2 2 4-4" />
        </svg>
    );
}
