-- Spec 0038 Q-D3 (PR D): the stack's test clock archives only an institution leaving that never went live, which the
-- worker reads from its open offboarding's previous status. The worker's role reads that one column as well; it
-- writes nothing new. Expand only.
GRANT SELECT (previous_status) ON public.platform_tenant_offboarding TO univarse_app_platform;
