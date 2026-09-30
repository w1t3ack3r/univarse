
import React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

export interface MorphInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    wrapperClassName?: string;
    icon?: React.ReactNode;
}

export function MorphInput({ className, wrapperClassName, icon, ...props }: MorphInputProps) {
    return (
        <div className={cn("relative", wrapperClassName)}>
            {icon && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
                    {icon}
                </div>
            )}
            <Input
                className={cn(
                    "input-morph",
                    icon && "pl-10",
                    className
                )}
                {...props}
            />
        </div>
    );
}
