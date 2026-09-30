'use client';

import { useState, useEffect } from 'react';
import {
    CreditCard,
    Mail,
    HardDrive,
    Cpu,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Plus,
    Settings,
    ShieldCheck,
    X,
    Eye,
    EyeOff,
    Save,
    RotateCw,
    Trash2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from 'sonner';

// Mock Data Types
type IntegrationStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'PENDING';
type IntegrationCategory = 'PAYMENT' | 'COMMUNICATION' | 'STORAGE' | 'AI';

interface Integration {
    id: string;
    name: string;
    provider: string; // e.g., 'Stripe', 'SendGrid'
    category: IntegrationCategory;
    description: string;
    status: IntegrationStatus;
    logo: React.ReactNode;
    configFields: { key: string; label: string; type: 'text' | 'password'; value: string }[];
    lastSync?: string;
}

export default function IntegrationsPage() {
    const [isLoading, setIsLoading] = useState(true);
    const [integrations, setIntegrations] = useState<Integration[]>([]);
    const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
    const [isConfigOpen, setIsConfigOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});

    // Icon Mapping
    const getIcon = (provider: string) => {
        switch (provider) {
            case 'Stripe': return <CreditCard className="w-8 h-8 text-[#635BFF]" />;
            case 'Paystack': return <CreditCard className="w-8 h-8 text-[#0BA4DB]" />;
            case 'SendGrid': return <Mail className="w-8 h-8 text-[#1A82E2]" />;
            case 'Twilio': return <Mail className="w-8 h-8 text-[#F22F46]" />;
            case 'AWS S3': return <HardDrive className="w-8 h-8 text-[#FF9900]" />;
            case 'OpenAI': return <Cpu className="w-8 h-8 text-[#10A37F]" />;
            default: return <Settings className="w-8 h-8 text-gray-400" />;
        }
    };

    // Initial Mock Data
    useEffect(() => {
        const fetchIntegrations = async () => {
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                setIntegrations([
                    {
                        id: '1',
                        name: 'Stripe Payments',
                        provider: 'Stripe',
                        category: 'PAYMENT',
                        description: 'Process global credit card payments and subscriptions.',
                        status: 'CONNECTED',
                        logo: getIcon('Stripe'),
                        configFields: [
                            { key: 'publishable_key', label: 'Publishable Key', type: 'text', value: 'pk_test_...' },
                            { key: 'secret_key', label: 'Secret Key', type: 'password', value: 'sk_test_...' }
                        ],
                        lastSync: new Date().toISOString()
                    },
                    {
                        id: '2',
                        name: 'Paystack',
                        provider: 'Paystack',
                        category: 'PAYMENT',
                        description: 'Accept payments across Africa with Paystack.',
                        status: 'DISCONNECTED',
                        logo: getIcon('Paystack'),
                        configFields: [
                            { key: 'public_key', label: 'Public Key', type: 'text', value: '' },
                            { key: 'secret_key', label: 'Secret Key', type: 'password', value: '' }
                        ]
                    },
                    {
                        id: '3',
                        name: 'SendGrid Email',
                        provider: 'SendGrid',
                        category: 'COMMUNICATION',
                        description: 'Transactional email delivery service.',
                        status: 'CONNECTED',
                        logo: getIcon('SendGrid'),
                        configFields: [
                            { key: 'api_key', label: 'API Key', type: 'password', value: 'SG.example...' }
                        ],
                        lastSync: new Date(Date.now() - 3600000).toISOString()
                    },
                    {
                        id: '4',
                        name: 'AWS S3 Storage',
                        provider: 'AWS S3',
                        category: 'STORAGE',
                        description: 'Scalable cloud storage for file uploads.',
                        status: 'ERROR',
                        logo: getIcon('AWS S3'),
                        configFields: [
                            { key: 'access_key', label: 'Access Key ID', type: 'text', value: 'AKIA...' },
                            { key: 'secret_key', label: 'Secret Access Key', type: 'password', value: 'wJalr...' },
                            { key: 'region', label: 'Region', type: 'text', value: 'us-east-1' },
                            { key: 'bucket', label: 'Bucket Name', type: 'text', value: 'univarse-uploads' }
                        ],
                        lastSync: new Date(Date.now() - 86400000).toISOString()
                    },
                    {
                        id: '5',
                        name: 'OpenAI GPT-4',
                        provider: 'OpenAI',
                        category: 'AI',
                        description: 'Power AI features like tutoring and content generation.',
                        status: 'PENDING',
                        logo: getIcon('OpenAI'),
                        configFields: [
                            { key: 'api_key', label: 'API Key', type: 'password', value: '' }
                        ]
                    }
                ]);
            } catch (error) {
                toast.error('Failed to load integrations');
            } finally {
                setIsLoading(false);
            }
        };

        fetchIntegrations();
    }, []);

    const handleConfigure = (integration: Integration) => {
        setSelectedIntegration({ ...integration });
        setIsConfigOpen(true);
    };

    const handleSaveConfig = async () => {
        if (!selectedIntegration) return;
        setIsSaving(true);

        // Mock API Call
        try {
            await new Promise(resolve => setTimeout(resolve, 1500));

            setIntegrations(prev => prev.map(i =>
                i.id === selectedIntegration.id
                    ? { ...selectedIntegration, status: 'CONNECTED', lastSync: new Date().toISOString() }
                    : i
            ));

            toast.success(`${selectedIntegration.provider} configuration saved successfully.`);
            setIsConfigOpen(false);
        } catch (error) {
            toast.error('Failed to save configuration.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDisconnect = async (id: string, name: string) => {
        try {
            toast.promise(
                new Promise(resolve => setTimeout(resolve, 1000)),
                {
                    loading: 'Disconnecting...',
                    success: () => {
                        setIntegrations(prev => prev.map(i => i.id === id ? { ...i, status: 'DISCONNECTED' } : i));
                        return `${name} disconnected.`;
                    },
                    error: 'Failed to disconnect.'
                }
            );
        } catch (error) {
            console.error(error);
        }
    };

    const togglePasswordVisibility = (key: string) => {
        setVisibleKeys(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const updateConfigField = (index: number, value: string) => {
        if (!selectedIntegration) return;
        const newFields = [...selectedIntegration.configFields];
        newFields[index] = { ...newFields[index], value };
        setSelectedIntegration({ ...selectedIntegration, configFields: newFields });
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading global integrations...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550] flex items-center gap-3">
                        <Cpu className="w-6 h-6 text-[#C0EB6A]" />
                        Integrations Hub
                    </h2>
                    <p className="text-[#6B7C6F]">Manage 3rd party connections and API keys globally.</p>
                </div>
                <Button className="btn-morph-primary">
                    <RotateCw className="w-4 h-4 mr-2" />
                    Sync All Statuses
                </Button>
            </div>

            {/* Integration Categories */}
            {['PAYMENT', 'COMMUNICATION', 'STORAGE', 'AI'].map((category) => {
                const categoryIntegrations = integrations.filter(i => i.category === category);
                if (categoryIntegrations.length === 0) return null;

                return (
                    <div key={category} className="space-y-4">
                        <h3 className="text-sm font-bold text-[#6B7C6F] uppercase tracking-wider flex items-center gap-2">
                            {category === 'PAYMENT' && <CreditCard className="w-4 h-4" />}
                            {category === 'COMMUNICATION' && <Mail className="w-4 h-4" />}
                            {category === 'STORAGE' && <HardDrive className="w-4 h-4" />}
                            {category === 'AI' && <Cpu className="w-4 h-4" />}
                            {category} Services
                        </h3>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {categoryIntegrations.map((integration) => (
                                <div key={integration.id} className={`morph-card p-6 flex flex-col justify-between h-full group transition-all hover:-translate-y-1 hover:shadow-lg ${integration.status === 'CONNECTED' ? 'border-b-4 border-green-500' :
                                    integration.status === 'ERROR' ? 'border-b-4 border-red-500' :
                                        integration.status === 'PENDING' ? 'border-b-4 border-amber-500' :
                                            'border-b-4 border-gray-300'
                                    }`}>
                                    <div>
                                        <div className="flex items-start justify-between mb-4">
                                            <div className="p-3 rounded-2xl bg-white shadow-sm border border-[#F4F6F0]">
                                                {integration.logo}
                                            </div>
                                            <Badge className={`
                                                ${integration.status === 'CONNECTED' ? 'bg-green-100 text-green-700 hover:bg-green-100' : ''}
                                                ${integration.status === 'DISCONNECTED' ? 'bg-gray-100 text-gray-500 hover:bg-gray-100' : ''}
                                                ${integration.status === 'ERROR' ? 'bg-red-100 text-red-700 hover:bg-red-100' : ''}
                                                ${integration.status === 'PENDING' ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : ''}
                                            `}>
                                                {integration.status === 'CONNECTED' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                                                {integration.status === 'ERROR' && <AlertCircle className="w-3 h-3 mr-1" />}
                                                {integration.status}
                                            </Badge>
                                        </div>
                                        <h4 className="text-lg font-bold text-[#485550] mb-2">{integration.name}</h4>
                                        <p className="text-sm text-[#6B7C6F] mb-4">{integration.description}</p>
                                    </div>

                                    <div className="pt-4 border-t border-[#F4F6F0] flex items-center justify-between">
                                        <div className="text-xs text-[#6B7C6F]">
                                            {integration.lastSync ? `Synced: ${new Date(integration.lastSync).toLocaleDateString()}` : 'Never synced'}
                                        </div>
                                        <Button
                                            size="sm"
                                            variant={integration.status === 'CONNECTED' ? "outline" : "default"}
                                            className={integration.status === 'CONNECTED' ? "border-[#C0EB6A] text-[#485550]" : "bg-[#485550] text-white"}
                                            onClick={() => handleConfigure(integration)}
                                        >
                                            <Settings className="w-3 h-3 mr-1.5" />
                                            Configure
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}

            {/* Configuration Dialog */}
            <Dialog open={isConfigOpen} onOpenChange={setIsConfigOpen}>
                <DialogContent className="sm:max-w-3xl bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-5 h-full">
                        {/* Left Side - Visual */}
                        <div className="md:col-span-2 bg-[#E8EDE0]/50 p-8 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-[#D1DBC1]/50 relative overflow-hidden">
                            <div className="relative z-10 w-full flex flex-col items-center">
                                <div className="p-6 bg-white rounded-[2rem] shadow-sm mb-6 scale-110">
                                    {selectedIntegration?.logo}
                                </div>
                                <h3 className="text-[#485550] font-bold text-xl mb-2 text-center">{selectedIntegration?.name}</h3>
                                <Badge variant="outline" className="mb-4 bg-white/50 border-[#D1DBC1] text-[#6B7C6F]">
                                    {selectedIntegration?.category}
                                </Badge>
                                <p className="text-[#6B7C6F] text-sm text-center leading-relaxed px-4">
                                    {selectedIntegration?.description}
                                </p>
                            </div>
                        </div>

                        {/* Right Side - Form */}
                        <div className="md:col-span-3 p-8">
                            <DialogHeader className="mb-6">
                                <DialogTitle className="text-[#485550] text-xl font-bold">API Configuration</DialogTitle>
                                <DialogDescription className="text-[#6B7C6F]">
                                    Enter your credentials securely.
                                </DialogDescription>
                            </DialogHeader>

                            {selectedIntegration && (
                                <div className="space-y-6">
                                    {/* Status Warning if Error */}
                                    {selectedIntegration.status === 'ERROR' && (
                                        <div className="p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-sm">
                                            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
                                            <div>
                                                <p className="font-bold text-red-700">Connection Failed</p>
                                                <p className="text-red-600">Please verify your credentials.</p>
                                            </div>
                                        </div>
                                    )}

                                    <div className="space-y-4">
                                        {selectedIntegration.configFields.map((field, index) => (
                                            <div key={field.key} className="space-y-2">
                                                <Label className="text-[#485550] font-semibold text-sm">{field.label}</Label>
                                                <div className="relative">
                                                    <Input
                                                        type={field.type === 'password' && !visibleKeys[field.key] ? 'password' : 'text'}
                                                        value={field.value}
                                                        onChange={(e) => updateConfigField(index, e.target.value)}
                                                        className="bg-white border-[#D1DBC1] focus:border-[#C0EB6A] pr-10"
                                                        placeholder={`Enter ${field.label}`}
                                                    />
                                                    {field.type === 'password' && (
                                                        <button
                                                            type="button"
                                                            onClick={() => togglePasswordVisibility(field.key)}
                                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#485550]"
                                                        >
                                                            {visibleKeys[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <DialogFooter className="flex justify-between sm:justify-between items-center gap-4 pt-8 mt-2">
                                {selectedIntegration?.status === 'CONNECTED' ? (
                                    <Button variant="ghost" className="text-red-400 hover:bg-red-50 hover:text-red-600 px-2" onClick={() => {
                                        setIsConfigOpen(false);
                                        if (selectedIntegration) handleDisconnect(selectedIntegration.id, selectedIntegration.name);
                                    }}>
                                        <Trash2 className="w-4 h-4 mr-2" />
                                        Disconnect
                                    </Button>
                                ) : <div />}

                                <div className="flex gap-2">
                                    <Button variant="ghost" onClick={() => setIsConfigOpen(false)} className="text-[#6B7C6F]">Cancel</Button>
                                    <Button onClick={handleSaveConfig} disabled={isSaving} className="btn-morph-primary">
                                        {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                                        Save & Connect
                                    </Button>
                                </div>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
