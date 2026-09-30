
import React from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

interface MorphCardProps extends React.HTMLAttributes<HTMLDivElement> {
    children: React.ReactNode;
    className?: string;
    hover?: boolean;
}

export function MorphCard({ children, className, hover = true, ...props }: MorphCardProps) {
    return (
        <div
            className={cn(
                "morph-card bg-white p-6",
                hover && "hover:-translate-y-0.5 transition-transform duration-300",
                className
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function MorphInset({ children, className, ...props }: MorphCardProps) {
    return (
        <div
            className={cn(
                "morph-inset",
                className
            )}
            {...props}
        >
            {children}
        </div>
    );
}
