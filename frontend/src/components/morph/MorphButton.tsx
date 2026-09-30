
import React from 'react';
import { cn } from '@/lib/utils';
import { Button, ButtonProps } from '@/components/ui/button';

interface MorphButtonProps extends Omit<ButtonProps, 'variant'> {
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | 'morph-primary' | 'morph-secondary';
}

export function MorphButton({ className, variant = 'morph-primary', ...props }: MorphButtonProps) {
    const getVariantClass = () => {
        switch (variant) {
            case 'morph-primary':
                return 'btn-morph-primary';
            case 'morph-secondary':
                return 'btn-morph-secondary';
            default:
                return ''; // Fallback to default button styles if standard variant (handled by Button component if we passed it through, but here we likely want to use the class directly or wrap Shadcn Button)
        }
    };

    // If it's a standard shadcn variant, just pass it through
    if (['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'].includes(variant as string)) {
        return <Button className={className} variant={variant as any} {...props} />;
    }

    return (
        <Button
            className={cn(getVariantClass(), className)}
            {...props}
        />
    );
}
