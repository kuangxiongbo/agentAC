'use client'

import React, { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3l1.2 4.2L17.4 8.4 13.2 9.6 12 13.8 10.8 9.6 6.6 8.4l4.2-1.2L12 3z" />
      <path d="M5 14l.8 2.8L8.6 17.6 5.8 18.4 5 21.2 4.2 18.4 1.4 17.6l2.8-.8L5 14z" />
    </svg>
  )
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  )
}

function ShieldCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function BadgeCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function BuildingIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
    </svg>
  )
}

type JoinSuggestion = {
  tenantId: string;
  tenantName: string;
  slug: string;
  loginRouteSegment?: string | null;
  score: number;
} | null;

type JoinSearchResult = {
  exactMatch: boolean;
  tenant?: {
    tenantId: string;
    tenantName: string;
    slug: string;
  };
  suggestion?: JoinSuggestion;
} | null;

export type OnboardingStatus = {
  hasTenant: boolean
  tenant?: {
    id: string
    name: string
    slug: string
    role: string
  }
  applications?: Array<{
    id: number
    status: string
    createdAt: string
    tenantId: number
    tenantName: string
  }>
} | null

export type TenantOnboardingGateProps = {
  email: string;
  displayName: string;
  joinTenantHint: string;
  setJoinTenantHint: (v: string) => void;
  joinDisplayName: string;
  setJoinDisplayName: (v: string) => void;
  joinMessage: string;
  setJoinMessage: (v: string) => void;
  joinBusy: boolean;
  joinSearchBusy: boolean;
  joinErr: string | null;
  joinDelivery: 'smtp' | 'log' | null;
  joinSuggestion: JoinSuggestion;
  joinSearchResult: JoinSearchResult;
  onboardingStatus: OnboardingStatus
  verifiedRegTenantName: string;
  setVerifiedRegTenantName: (v: string) => void;
  verifiedRegTenantSlug: string;
  setVerifiedRegTenantSlug: (v: string) => void;
  verifiedRegDisplayName: string;
  setVerifiedRegDisplayName: (v: string) => void;
  verifiedRegBusy: boolean;
  verifiedRegErr: string | null;
  onJoinExistingTenant: (e: React.FormEvent) => void;
  onApplyJoinTenant: (tenantHintOverride?: string) => void | Promise<void>;
  onRegisterTenantFromVerified: (e: React.FormEvent) => void;
  onRefreshOnboardingStatus: () => void | Promise<void>;
  onResumeConsole: () => void;
};

export function TenantOnboardingGate(props: TenantOnboardingGateProps) {
  const t = useTranslations('auth.tenantOnboarding')
  const [tab, setTab] = useState<'register' | 'join'>('register')

  useEffect(() => {
    setTab('register');
  }, [props.email]);

  useEffect(() => {
    if (!props.onboardingStatus?.hasTenant) return;
    const t = window.setTimeout(() => {
      props.onResumeConsole();
    }, 1200);
    return () => window.clearTimeout(t);
  }, [props.onboardingStatus?.hasTenant, props.onResumeConsole]);

  const inputClass =
    'w-full rounded-[1.35rem] border border-white/10 bg-white/[0.05] px-5 py-4 text-sm text-white outline-none transition-all placeholder:text-white/25 focus:border-[#D23023]/50 focus:bg-white/[0.08]';
  const sectionLabelClass = 'text-[10px] font-black uppercase tracking-[0.25em] text-white/35';
  const infoCardClass = 'rounded-[1.6rem] border border-white/10 bg-white/[0.04] p-5';
  const latestApplication =
    Array.isArray(props.onboardingStatus?.applications) && props.onboardingStatus?.applications?.length
      ? props.onboardingStatus.applications[0]
      : null;
  const latestApplicationStatus = String(latestApplication?.status || '').trim().toLowerCase();
  const tabClass = (active: boolean) =>
    `rounded-[1.2rem] px-4 py-4 text-sm font-black tracking-wide transition-all ${
      active ? 'bg-[#D23023] text-white shadow-lg shadow-[#D23023]/30' : 'text-white/55 hover:bg-white/8'
    }`;

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-[#050914]/82 p-4 backdrop-blur-xl">
      <div className="relative w-full max-w-5xl overflow-hidden rounded-[2.6rem] border border-white/10 bg-[#111522]/96 text-white shadow-[0_30px_120px_rgba(0,0,0,0.58)]">
        <div className="absolute -left-20 top-10 h-56 w-56 rounded-full bg-[#D23023]/12 blur-3xl" />
        <div className="absolute right-0 top-0 h-72 w-72 rounded-full bg-emerald-400/8 blur-3xl" />
        <div className="relative grid gap-0 lg:grid-cols-[0.92fr_1.08fr]">
          <aside className="border-b border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] p-8 lg:border-b-0 lg:border-r">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] font-black uppercase tracking-[0.32em] text-white/60">
              <SparklesIcon className="h-3 w-3" />
              {t('badge')}
            </div>
            <h2 className="mt-6 text-3xl font-black tracking-tight text-white">{t('welcome')}</h2>

            <div className="mt-8 space-y-4">
              <div className="rounded-[1.7rem] border border-emerald-400/20 bg-emerald-400/[0.07] p-5">
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-emerald-100/70">{t('currentAccount')}</p>
                <p className="mt-3 flex items-center gap-2 text-base font-black text-emerald-50">
                  <MailIcon className="h-4 w-4 shrink-0" />
                  {props.email}
                </p>
                <p className="mt-2 text-sm font-bold text-emerald-100/72">{props.displayName}</p>
              </div>

              <div className={infoCardClass}>
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/35">绑定后可用</p>
                <div className="mt-4 space-y-3 text-sm font-bold text-white/58">
                  <div className="flex items-start gap-3">
                    <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-white/70" />
                    <p>权限、站点、统计和成员管理。</p>
                  </div>
                  <div className="flex items-start gap-3">
                    <UsersIcon className="mt-0.5 h-4 w-4 shrink-0 text-white/70" />
                    <p>工作台和业务数据。</p>
                  </div>
                </div>
              </div>

              <div className={infoCardClass}>
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/35">首登路径</p>
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-[1.1rem] bg-white/[0.03] px-4 py-3 text-sm font-black text-white/78">
                    <span>1. 选择创建或加入</span>
                    <ArrowRightIcon className="h-3.5 w-3.5 text-white/35" />
                  </div>
                  <div className="flex items-center justify-between rounded-[1.1rem] bg-white/[0.03] px-4 py-3 text-sm font-black text-white/78">
                    <span>2. 完成单位绑定</span>
                    <ArrowRightIcon className="h-3.5 w-3.5 text-white/35" />
                  </div>
                  <div className="flex items-center justify-between rounded-[1.1rem] bg-white/[0.03] px-4 py-3 text-sm font-black text-white/78">
                    <span>3. 开始进入控制台</span>
                    <BadgeCheckIcon className="h-3.5 w-3.5 text-emerald-300" />
                  </div>
                </div>
              </div>
            </div>
          </aside>

          <section className="p-8 lg:p-10">
            <div className="mb-6">
              <p className="text-[10px] font-black uppercase tracking-[0.35em] text-white/30">Step 1 / 2</p>
              <h3 className="mt-3 text-2xl font-black tracking-tight text-white">
                {props.onboardingStatus?.hasTenant
                  ? '单位已就绪，回到控制台继续'
                  : latestApplicationStatus === 'pending'
                    ? '申请已提交，等待管理员审批'
                    : tab === 'register'
                      ? '创建你的首个单位空间'
                      : '搜索并加入已有单位'}
              </h3>
            </div>

            {props.onboardingStatus?.hasTenant && props.onboardingStatus.tenant ? (
              <div className="space-y-5">
                <div className="rounded-[1.8rem] border border-emerald-400/20 bg-emerald-400/[0.07] p-6">
                  <p className="text-[10px] font-black uppercase tracking-[0.28em] text-emerald-100/70">当前单位</p>
                  <p className="mt-3 text-2xl font-black text-white">{props.onboardingStatus.tenant.name}</p>
                  <p className="mt-2 font-mono text-xs text-emerald-100/70">
                    {props.onboardingStatus.tenant.slug} · {props.onboardingStatus.tenant.role}
                  </p>
                  <p className="mt-4 text-sm font-bold leading-relaxed text-emerald-50/85">
                    用户中心已确认你属于该单位。现在重新进入业务控制台，业务侧会根据统一租户数据补齐本地投影。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={props.onResumeConsole}
                  className="w-full rounded-[1.45rem] bg-emerald-600 py-4 text-sm font-black tracking-[0.2em] text-white shadow-2xl shadow-emerald-600/25 transition-all hover:bg-emerald-500"
                >
                  返回控制台
                </button>
              </div>
            ) : latestApplicationStatus === 'pending' ? (
              <div className="space-y-5">
                <div className="rounded-[1.8rem] border border-amber-300/20 bg-amber-300/[0.08] p-6">
                  <p className="text-[10px] font-black uppercase tracking-[0.28em] text-amber-100/70">等待审批</p>
                  <p className="mt-3 text-2xl font-black text-white">{latestApplication?.tenantName || '目标单位'}</p>
                  <p className="mt-2 text-sm font-bold leading-relaxed text-amber-50/85">
                    你的加入申请已经提交。管理员审批通过后，单位关系会统一登记在用户中心。届时你重新登录业务系统即可直接进入控制台。
                  </p>
                </div>
                <div className="rounded-[1.35rem] border border-white/8 bg-white/[0.03] px-4 py-4 text-[11px] font-bold leading-relaxed text-white/45">
                  <div>申请状态：待审批</div>
                  <div className="mt-1">申请时间：{latestApplication?.createdAt || '—'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void props.onRefreshOnboardingStatus()}
                  className="w-full rounded-[1.45rem] border border-white/15 py-4 text-sm font-black tracking-[0.2em] text-white transition-all hover:bg-white/10"
                >
                  刷新审批状态
                </button>
              </div>
            ) : (
              <>
                <div className="mb-8 grid grid-cols-2 gap-3 rounded-[1.5rem] bg-white/[0.04] p-2">
                  <button type="button" onClick={() => setTab('register')} className={tabClass(tab === 'register')}>
                    注册单位
                  </button>
                  <button type="button" onClick={() => setTab('join')} className={tabClass(tab === 'join')}>
                    加入已有单位
                  </button>
                </div>

                {latestApplicationStatus === 'rejected' ? (
                  <div className="mb-5 rounded-[1.35rem] border border-[#D23023]/25 bg-[#D23023]/10 px-4 py-4 text-sm font-bold leading-relaxed text-[#FF8D85]">
                    你上一条加入申请未通过。请核对单位名称后重新申请，或联系单位管理员确认。
                  </div>
                ) : null}

                {tab === 'register' ? (
                  <form onSubmit={props.onRegisterTenantFromVerified} className="space-y-5">
                    {props.verifiedRegErr ? (
                      <p className="rounded-2xl bg-[#D23023]/15 px-4 py-3 text-sm font-bold text-[#FF8D85]">{props.verifiedRegErr}</p>
                    ) : null}
                    <div className="rounded-[1.8rem] border border-white/8 bg-white/[0.03] p-5">
                      <div className="space-y-5">
                        <div className="space-y-2">
                          <label className={sectionLabelClass}>单位名称</label>
                          <input
                            required
                            type="text"
                            value={props.verifiedRegTenantName}
                            onChange={(e) => props.setVerifiedRegTenantName(e.target.value)}
                            className={inputClass}
                            placeholder="例如：一生智创"
                          />
                        </div>
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <label className={sectionLabelClass}>登录地址（可选）</label>
                            <input
                              type="text"
                              value={props.verifiedRegTenantSlug}
                              onChange={(e) => props.setVerifiedRegTenantSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                              className={`${inputClass} font-mono`}
                              placeholder="留空则系统分配"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className={sectionLabelClass}>显示名（可选）</label>
                            <input
                              type="text"
                              value={props.verifiedRegDisplayName}
                              onChange={(e) => props.setVerifiedRegDisplayName(e.target.value)}
                              className={inputClass}
                              placeholder="默认使用当前认证账号显示名"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={props.verifiedRegBusy}
                      className="w-full rounded-[1.45rem] bg-[#D23023] py-4 text-sm font-black tracking-[0.2em] text-white shadow-2xl shadow-[#D23023]/35 transition-all hover:brightness-110 disabled:opacity-50"
                    >
                      {props.verifiedRegBusy ? '提交中...' : '立即注册单位'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={props.onJoinExistingTenant} className="space-y-5">
                    {props.joinErr ? (
                      <p className="rounded-2xl bg-[#D23023]/15 px-4 py-3 text-sm font-bold text-[#FF8D85]">{props.joinErr}</p>
                    ) : null}
                    <div className="rounded-[1.8rem] border border-white/8 bg-white/[0.03] p-5">
                      <div className="space-y-5">
                        <div className="space-y-2">
                          <label className={sectionLabelClass}>单位标识</label>
                          <div className="relative">
                            <SearchIcon className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/28" />
                            <input
                              required
                              type="text"
                              value={props.joinTenantHint}
                              onChange={(e) => props.setJoinTenantHint(e.target.value)}
                              className={`${inputClass} pl-12`}
                              placeholder="单位名称、登录地址 slug 或租户 ID"
                            />
                          </div>
                          <p className="text-xs font-bold leading-relaxed text-white/34">
                            支持完整单位名称、单位登录短链或租户 ID。先搜索，再决定是否发送申请。
                          </p>
                          {props.joinSuggestion && !props.joinSearchResult ? (
                            <div className="rounded-[1.35rem] border border-amber-300/20 bg-amber-300/8 px-4 py-3 text-sm font-bold text-amber-100">
                              <p>
                                推荐单位：<span className="text-white">{props.joinSuggestion.tenantName}</span>
                                <span className="ml-2 font-mono text-amber-200/80">
                                  匹配度 {(props.joinSuggestion.score * 100).toFixed(0)}%
                                </span>
                              </p>
                              <p className="mt-1 text-amber-100/75">
                                可用标识：
                                <span className="ml-1 font-mono text-white">
                                  {props.joinSuggestion.loginRouteSegment || props.joinSuggestion.slug}
                                </span>
                              </p>
                              <button
                                type="button"
                                onClick={() =>
                                  props.setJoinTenantHint(
                                    props.joinSuggestion?.loginRouteSegment ||
                                      props.joinSuggestion?.slug ||
                                      props.joinSuggestion?.tenantName ||
                                      ''
                                  )
                                }
                                className="mt-3 rounded-xl border border-amber-200/30 px-3 py-2 text-[10px] font-black tracking-wide text-amber-50 transition-all hover:bg-white/10"
                              >
                                使用这个单位
                              </button>
                            </div>
                          ) : null}
                        </div>

                        {props.joinSearchResult ? (
                          <div className="rounded-[1.45rem] border border-white/10 bg-[#0d1320] p-5">
                            {props.joinSearchResult.exactMatch && props.joinSearchResult.tenant ? (
                              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                                <div>
                                  <p className="text-[10px] font-black uppercase tracking-[0.28em] text-emerald-200/70">精确匹配成功</p>
                                  <p className="mt-2 text-xl font-black text-white">{props.joinSearchResult.tenant.tenantName}</p>
                                  <p className="mt-2 font-mono text-xs text-white/42">{props.joinSearchResult.tenant.slug}</p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void props.onApplyJoinTenant(props.joinSearchResult?.tenant?.tenantId)}
                                  disabled={props.joinBusy}
                                  className="rounded-[1.1rem] bg-emerald-600 px-5 py-3 text-sm font-black text-white transition-all hover:bg-emerald-500 disabled:opacity-50"
                                >
                                  {props.joinBusy ? '申请中...' : '发送申请'}
                                </button>
                              </div>
                            ) : props.joinSearchResult.suggestion ? (
                              <div className="text-center">
                                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-amber-200/70">推荐候选单位</p>
                                <p className="mt-3 text-xl font-black text-white">{props.joinSearchResult.suggestion.tenantName}</p>
                                <p className="mt-2 text-[11px] font-bold text-amber-200/80">
                                  匹配度 {(props.joinSearchResult.suggestion.score * 100).toFixed(0)}%
                                </p>
                                <p className="mt-2 font-mono text-xs text-white/42">
                                  {props.joinSearchResult.suggestion.loginRouteSegment || props.joinSearchResult.suggestion.slug}
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void props.onApplyJoinTenant(
                                      props.joinSearchResult?.suggestion?.loginRouteSegment ||
                                        props.joinSearchResult?.suggestion?.slug ||
                                        props.joinSearchResult?.suggestion?.tenantId
                                    )
                                  }
                                  disabled={props.joinBusy}
                                  className="mt-4 rounded-[1.1rem] bg-amber-500 px-5 py-3 text-sm font-black text-white transition-all hover:bg-amber-400 disabled:opacity-50"
                                >
                                  {props.joinBusy ? '提交申请中...' : '是的，向该单位发送入驻申请'}
                                </button>
                              </div>
                            ) : (
                              <div className="text-center text-sm font-bold text-white/60">
                                未找到匹配的单位记录，请检查名称是否正确，或联系单位管理员获取准确名称。
                              </div>
                            )}
                          </div>
                        ) : null}

                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <label className={sectionLabelClass}>显示名</label>
                            <input
                              type="text"
                              value={props.joinDisplayName}
                              onChange={(e) => props.setJoinDisplayName(e.target.value)}
                              className={inputClass}
                              placeholder="提交给单位管理员的称呼"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className={sectionLabelClass}>申请留言（可选）</label>
                            <textarea
                              value={props.joinMessage}
                              onChange={(e) => props.setJoinMessage(e.target.value)}
                              className={`${inputClass} min-h-[110px] resize-none`}
                              placeholder="例如：我是华东运营同事，请加入现有团队"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                    {props.joinDelivery === 'log' ? (
                      <p className="text-center text-[11px] font-bold text-amber-200/80">
                        当前未配置 SMTP，申请通知会写入服务器日志，申请仍会在后台留档。
                      </p>
                    ) : null}
                    <button
                      type="submit"
                      disabled={props.joinSearchBusy}
                      className="w-full rounded-[1.45rem] bg-[#D23023] py-4 text-sm font-black tracking-[0.2em] text-white shadow-2xl shadow-[#D23023]/35 transition-all hover:brightness-110 disabled:opacity-50"
                    >
                      {props.joinSearchBusy ? '搜索中...' : '搜索单位'}
                    </button>
                  </form>
                )}

                <div className="mt-6 rounded-[1.35rem] border border-white/8 bg-white/[0.03] px-4 py-4 text-[11px] font-bold leading-relaxed text-white/45">
                  <div className="flex items-center gap-2 text-white/55">
                    <BuildingIcon className="h-3.5 w-3.5" />
                    完成单位绑定前，控制台主功能保持锁定状态。
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
