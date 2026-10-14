import { useState, type FormEvent } from 'react';
import {
  useTelemetry,
  getDefaultPermissionsForClearance,
  type IAMUserRecord,
  type PermissionScope,
} from '../context/TelemetryContext';
import {
  Users,
  UserPlus,
  ShieldCheck,
  KeyRound,
  Lock,
  Check,
  X,
  Clock,
  Search,
  Sparkles,
  Ban,
  CheckCircle2,
} from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';
import { toast } from 'sonner';

const ALL_PERMISSIONS: Array<{ scope: PermissionScope; label: string; desc: string }> = [
  { scope: 'gitops:merge', label: 'GitOps PR Merge', desc: 'Approve & merge patches in Autonomous Embassy' },
  { scope: 'circuit:override', label: 'Circuit Override', desc: 'Unlock tripped HTTP 423 microservice breakers' },
  { scope: 'telemetry:ingest', label: 'Telemetry Ingest', desc: 'Upload batch logs & rotate ingestion tokens' },
  { scope: 'iam:manage', label: 'IAM Admin', desc: 'Provision users, approve requests & revoke access' },
  { scope: 'merkle:export', label: 'Merkle & Statutory Export', desc: 'Export CERT-In 70B & SEBI CSCRF SBOM packets' },
];

export function UserAccessPortal() {
  const {
    user,
    iamUsers,
    accessRequests,
    provisionIAMUser,
    updateIAMUserClearance,
    toggleIAMUserStatus,
    revokeIAMUser,
    grantJitElevation,
    approveAccessRequest,
    denyAccessRequest,
  } = useTelemetry();

  const [activeTab, setActiveTab] = useState<'DIRECTORY' | 'PROVISION' | 'REQUESTS' | 'MATRIX'>('DIRECTORY');
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string>(iamUsers[0]?.id || 'iam-1');

  // New User Provisioning Form State
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('Senior Site Reliability Engineer');
  const [newClearance, setNewClearance] = useState<IAMUserRecord['clearance']>('LEVEL 3');
  const [newTenant, setNewTenant] = useState('org-neurofabric-prod');
  const [newProvider, setNewProvider] = useState<IAMUserRecord['provider']>('Google Workspace');
  const [newPerms, setNewPerms] = useState<PermissionScope[]>(getDefaultPermissionsForClearance('LEVEL 3'));

  const canManageIAM = user.permissions.includes('iam:manage');
  const pendingRequests = accessRequests.filter((r) => r.status === 'PENDING');

  const filteredUsers = iamUsers.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.role.toLowerCase().includes(search.toLowerCase())
  );

  const selectedRecord = iamUsers.find((u) => u.id === selectedUserId) || iamUsers[0];

  const handleClearancePresetChange = (lvl: IAMUserRecord['clearance']) => {
    setNewClearance(lvl);
    setNewPerms(getDefaultPermissionsForClearance(lvl));
  };

  const toggleNewPerm = (scope: PermissionScope) => {
    setNewPerms((prev) =>
      prev.includes(scope) ? prev.filter((p) => p !== scope) : [...prev, scope]
    );
  };

  const handleProvisionSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canManageIAM) {
      toast.error('RBAC Permission Denied (HTTP 403)', {
        description: 'Only operators with "iam:manage" scope can provision new identities.',
      });
      return;
    }
    if (!newName.trim() || !newEmail.trim()) return;

    provisionIAMUser({
      name: newName.trim(),
      email: newEmail.trim(),
      role: newRole.trim(),
      clearance: newClearance,
      tenantId: newTenant,
      status: 'ACTIVE',
      mfaEnforced: true,
      provider: newProvider,
      permissions: newPerms,
    });

    setNewName('');
    setNewEmail('');
    setActiveTab('DIRECTORY');
  };

  const toggleExistingUserPerm = (record: IAMUserRecord, scope: PermissionScope) => {
    if (!canManageIAM) {
      toast.error('RBAC Permission Denied', { description: 'Requires iam:manage permission scope.' });
      return;
    }
    const nextPerms = record.permissions.includes(scope)
      ? record.permissions.filter((p) => p !== scope)
      : [...record.permissions, scope];
    updateIAMUserClearance(record.id, record.clearance, record.role, nextPerms);
  };

  return (
    <div className="space-y-6 font-sans">
      {/* Top KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 font-mono">
        <div className="p-5 rounded-2xl nf-card">
          <div className="text-[10px] text-slate-400 uppercase font-bold">Provisioned Identities</div>
          <div className="text-2xl font-extrabold text-emerald-400 mt-1">
            {iamUsers.filter((u) => u.status === 'ACTIVE').length} / {iamUsers.length}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Zero unauthenticated access</div>
        </div>

        <div className="p-5 rounded-2xl nf-card">
          <div className="text-[10px] text-amber-400 uppercase font-bold">Pending Access Requests</div>
          <div className="text-2xl font-extrabold text-white mt-1">{pendingRequests.length}</div>
          <div className="text-[10px] text-amber-300 mt-1">Awaiting Level 5 sign-off</div>
        </div>

        <div className="p-5 rounded-2xl nf-card">
          <div className="text-[10px] text-cyan-400 uppercase font-bold">JIT Break-Glass Active</div>
          <div className="text-2xl font-extrabold text-cyan-300 mt-1">
            {iamUsers.filter((u) => Boolean(u.jitExpiresAt)).length}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Time-bounded 30m elevation</div>
        </div>

        <div className="p-5 rounded-2xl nf-card">
          <div className="text-[10px] text-purple-400 uppercase font-bold">Session Security Mode</div>
          <div className="text-base font-extrabold text-emerald-300 mt-1.5">TOTP MFA + PBKDF2</div>
          <div className="text-[10px] text-slate-400 mt-1">Volatile RAM (0 localStorage)</div>
        </div>
      </div>

      {/* Portal Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <button
            onClick={() => setActiveTab('DIRECTORY')}
            className={`px-4 py-2 rounded-xl font-bold flex items-center space-x-2 transition ${
              activeTab === 'DIRECTORY'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-[#101420] text-slate-300 hover:text-white border border-white/10'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Operator Directory ({iamUsers.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('PROVISION')}
            className={`px-4 py-2 rounded-xl font-bold flex items-center space-x-2 transition ${
              activeTab === 'PROVISION'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-[#101420] text-slate-300 hover:text-white border border-white/10'
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>+ Grant / Provision User Access</span>
          </button>

          <button
            onClick={() => setActiveTab('REQUESTS')}
            className={`px-4 py-2 rounded-xl font-bold flex items-center space-x-2 transition ${
              activeTab === 'REQUESTS'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-[#101420] text-slate-300 hover:text-white border border-white/10'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>Access Requests Queue</span>
            {pendingRequests.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-slate-950 text-[10px] font-extrabold">
                {pendingRequests.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('MATRIX')}
            className={`px-4 py-2 rounded-xl font-bold flex items-center space-x-2 transition ${
              activeTab === 'MATRIX'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-[#101420] text-slate-300 hover:text-white border border-white/10'
            }`}
          >
            <Lock className="w-3.5 h-3.5" />
            <span>RBAC Policy Matrix</span>
          </button>
        </div>

        <div className="relative w-full md:w-72">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter operators by email or role..."
            className="w-full bg-[#05070B] border border-white/10 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
          />
        </div>
      </div>

      {/* TAB 1: OPERATOR DIRECTORY & GRANULAR PERMISSION INSPECTOR */}
      {activeTab === 'DIRECTORY' && (
        <div className="grid lg:grid-cols-12 gap-6">
          {/* Left 7 Cols: Directory List */}
          <div className="lg:col-span-7 space-y-3">
            {filteredUsers.map((u) => {
              const isSelected = u.id === selectedRecord.id;
              return (
                <div
                  key={u.id}
                  onClick={() => setSelectedUserId(u.id)}
                  className={`p-4 rounded-2xl border cursor-pointer transition flex flex-wrap items-center justify-between gap-4 ${
                    isSelected
                      ? 'bg-gradient-to-r from-emerald-500/15 to-teal-500/10 border-emerald-400 shadow-lg'
                      : 'nf-card hover:border-white/25'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-bold text-white">{u.name}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 border border-white/10 text-emerald-300 font-bold">
                        {u.clearance}
                      </span>
                      <span
                        className={`text-[9px] font-mono px-2 py-0.5 rounded-full font-bold ${
                          u.status === 'ACTIVE'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                            : u.status === 'SUSPENDED'
                            ? 'bg-amber-950 text-amber-300 border border-amber-700'
                            : 'bg-rose-950 text-rose-300 border border-rose-700'
                        }`}
                      >
                        {u.status}
                      </span>
                      {u.jitExpiresAt && (
                        <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-700 font-bold">
                          JIT: {u.jitExpiresAt}
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-mono text-slate-300">{u.email}</div>
                    <div className="text-[11px] text-slate-400">
                      {u.role} • Tenant RLS: <span className="text-cyan-300 font-mono">{u.tenantId}</span>
                    </div>
                  </div>

                  <div className="flex flex-col items-end space-y-1.5 font-mono text-[10px]">
                    <span className="text-slate-400">{u.provider}</span>
                    <span className="text-emerald-400">{u.permissions.length} / 5 Scopes Active</span>
                    <span className="text-slate-500">Seen: {u.lastActive}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right 5 Cols: Selected Operator Access & Permission Controller */}
          <div className="lg:col-span-5">
            <div className="p-6 rounded-2xl nf-card space-y-5 sticky top-6">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div>
                  <span className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider">
                    Operator Access Policy Inspector
                  </span>
                  <h3 className="text-lg font-bold text-white mt-0.5">{selectedRecord.name}</h3>
                  <div className="text-xs font-mono text-slate-400">{selectedRecord.email}</div>
                </div>
                <span
                  className={`text-[10px] font-mono px-2.5 py-1 rounded-full font-bold ${
                    selectedRecord.status === 'ACTIVE'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  }`}
                >
                  {selectedRecord.status}
                </span>
              </div>

              {/* Clearance Level Selector */}
              <div className="space-y-1.5 font-mono text-xs">
                <label className="text-[10px] text-slate-400 block font-bold uppercase">
                  ASSIGNED RBAC CLEARANCE TIER
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {(['LEVEL 5', 'LEVEL 4', 'LEVEL 3', 'LEVEL 2'] as const).map((lvl) => (
                    <button
                      key={lvl}
                      onClick={() =>
                        updateIAMUserClearance(
                          selectedRecord.id,
                          lvl,
                          selectedRecord.role,
                          getDefaultPermissionsForClearance(lvl)
                        )
                      }
                      className={`py-2 rounded-xl text-[10px] font-bold border transition ${
                        selectedRecord.clearance === lvl
                          ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow'
                          : 'bg-[#090C14] text-slate-300 border-white/10 hover:text-white'
                      }`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>
              </div>

              {/* Granular Module Permissions */}
              <div className="space-y-2 font-mono text-xs">
                <label className="text-[10px] text-slate-400 block font-bold uppercase">
                  GRANULAR CAPABILITY SCOPES (CLICK TO TOGGLE)
                </label>
                <div className="space-y-1.5">
                  {ALL_PERMISSIONS.map((perm) => {
                    const hasPerm = selectedRecord.permissions.includes(perm.scope);
                    return (
                      <div
                        key={perm.scope}
                        onClick={() => toggleExistingUserPerm(selectedRecord, perm.scope)}
                        className={`p-2.5 rounded-xl border cursor-pointer flex items-center justify-between transition ${
                          hasPerm
                            ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                            : 'bg-[#07090F] border-white/10 text-slate-500 hover:border-white/25'
                        }`}
                      >
                        <div>
                          <div className="text-[11px] font-bold text-white flex items-center space-x-2">
                            <span>{perm.label}</span>
                            <code className="text-[10px] text-emerald-400">({perm.scope})</code>
                          </div>
                          <div className="text-[10px] text-slate-400 font-sans">{perm.desc}</div>
                        </div>
                        <div
                          className={`w-5 h-5 rounded-md flex items-center justify-center ${
                            hasPerm ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-500'
                          }`}
                        >
                          {hasPerm ? <Check className="w-3.5 h-3.5" /> : <X className="w-3 h-3" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* JIT Elevation & Account Lifecycle Actions */}
              <div className="pt-3 border-t border-white/10 space-y-2.5 font-mono text-xs">
                <button
                  onClick={() => grantJitElevation(selectedRecord.id, 30)}
                  className="w-full py-2.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/40 text-cyan-300 font-bold flex items-center justify-center space-x-1.5 transition"
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span>Grant 30-Minute JIT Break-Glass (Level 5)</span>
                </button>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    onClick={() => toggleIAMUserStatus(selectedRecord.id)}
                    className="py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 font-bold transition"
                  >
                    {selectedRecord.status === 'ACTIVE' ? 'Suspend User' : 'Activate User'}
                  </button>
                  <button
                    onClick={() => revokeIAMUser(selectedRecord.id)}
                    className="py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 font-bold flex items-center justify-center space-x-1 transition"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    <span>Revoke Access</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PROVISION / INVITE NEW USER */}
      {activeTab === 'PROVISION' && (
        <form onSubmit={handleProvisionSubmit} className="p-6 rounded-2xl nf-card max-w-3xl space-y-5 font-mono text-xs">
          <div className="border-b border-white/10 pb-3">
            <span className="text-[10px] text-emerald-400 font-bold uppercase">Zero-Trust Identity Provisioning</span>
            <h3 className="text-lg font-bold text-white font-sans mt-0.5">
              Grant Cockpit Access to a New Operator
            </h3>
            <p className="text-xs text-slate-400 font-sans mt-0.5">
              Once provisioned here, the user can immediately sign in at <code className="text-emerald-300">/login</code> using Google Workspace or their corporate email + TOTP MFA.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] text-slate-300 block mb-1">OPERATOR FULL NAME</label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Neha Gupta"
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
              />
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">CORPORATE / GOOGLE EMAIL</label>
              <input
                type="email"
                required
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="neha.gupta@neurofabric.io"
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
              />
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">JOB TITLE / DESIGNATION</label>
              <input
                type="text"
                required
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
              />
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">IDENTITY PROVIDER</label>
              <select
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value as IAMUserRecord['provider'])}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
              >
                <option value="Google Workspace">Google Workspace SSO</option>
                <option value="Corporate Email">Corporate Email + PBKDF2 + TOTP</option>
                <option value="SAML SSO">Enterprise SAML 2.0</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">RBAC CLEARANCE LEVEL</label>
              <select
                value={newClearance}
                onChange={(e) => handleClearancePresetChange(e.target.value as IAMUserRecord['clearance'])}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-emerald-300 font-bold"
              >
                <option value="LEVEL 5">LEVEL 5 (Sovereign Root Admin)</option>
                <option value="LEVEL 4">LEVEL 4 (SecOps &amp; Circuit Lead)</option>
                <option value="LEVEL 3">LEVEL 3 (On-Call SRE)</option>
                <option value="LEVEL 2">LEVEL 2 (Read-Only Compliance Auditor)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">ROW-LEVEL SECURITY (RLS) TENANT</label>
              <select
                value={newTenant}
                onChange={(e) => setNewTenant(e.target.value)}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-cyan-300"
              >
                <option value="org-neurofabric-prod">org-neurofabric-prod</option>
                <option value="org-fintech-eu-west">org-fintech-eu-west</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] text-slate-300 block">PERMISSION SCOPES</label>
            <div className="grid md:grid-cols-2 gap-2">
              {ALL_PERMISSIONS.map((perm) => {
                const checked = newPerms.includes(perm.scope);
                return (
                  <div
                    key={perm.scope}
                    onClick={() => toggleNewPerm(perm.scope)}
                    className={`p-3 rounded-xl border cursor-pointer flex items-center justify-between ${
                      checked
                        ? 'bg-emerald-950/40 border-emerald-500/50 text-white'
                        : 'bg-[#05070B] border-white/10 text-slate-500'
                    }`}
                  >
                    <div>
                      <div className="font-bold text-[11px]">{perm.label}</div>
                      <div className="text-[10px] text-slate-400 font-sans">{perm.scope}</div>
                    </div>
                    <CheckCircle2 className={`w-4 h-4 ${checked ? 'text-emerald-400' : 'text-slate-700'}`} />
                  </div>
                );
              })}
            </div>
          </div>

          <button
            type="submit"
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 font-bold text-xs flex items-center space-x-2 shadow-lg shadow-emerald-500/20"
          >
            <UserPlus className="w-4 h-4" />
            <span>Provision Operator &amp; Seal Merkle Leaf</span>
          </button>
        </form>
      )}

      {/* TAB 3: PENDING ACCESS REQUESTS QUEUE */}
      {activeTab === 'REQUESTS' && (
        <div className="space-y-3 font-mono text-xs">
          {accessRequests.map((req) => (
            <div
              key={req.id}
              className="p-5 rounded-2xl nf-card flex flex-wrap items-center justify-between gap-4"
            >
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-bold text-white font-sans">{req.name}</span>
                  <span className="text-emerald-400">{req.email}</span>
                  <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-bold">
                    Requested: {req.requestedClearance}
                  </span>
                  <span className="text-[10px] text-cyan-300">Tenant: {req.tenantId}</span>
                </div>
                <p className="text-xs text-slate-300 font-sans">{req.reason}</p>
                <div className="text-[10px] text-slate-500">Submitted: {req.requestedAt}</div>
              </div>

              {req.status === 'PENDING' ? (
                <div className="flex items-center space-x-2.5">
                  <button
                    onClick={() => approveAccessRequest(req.id)}
                    className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold flex items-center space-x-1.5 transition"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Approve &amp; Provision</span>
                  </button>
                  <button
                    onClick={() => denyAccessRequest(req.id)}
                    className="px-3.5 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 font-bold flex items-center space-x-1.5 transition"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Deny</span>
                  </button>
                </div>
              ) : (
                <span
                  className={`px-3 py-1 rounded-full text-[10px] font-bold ${
                    req.status === 'APPROVED'
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                      : 'bg-rose-950 text-rose-300 border border-rose-700'
                  }`}
                >
                  {req.status}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* TAB 4: RBAC POLICY MATRIX */}
      {activeTab === 'MATRIX' && (
        <div className="rounded-2xl nf-card overflow-hidden font-mono text-xs">
          <div className="p-4 bg-[#101420] grid grid-cols-6 text-[10px] text-slate-400 uppercase font-bold border-b border-white/10">
            <div className="col-span-2">Capability / Security Scope</div>
            <div className="text-center text-emerald-400">LEVEL 5 (Root)</div>
            <div className="text-center text-cyan-400">LEVEL 4 (SecOps)</div>
            <div className="text-center text-amber-400">LEVEL 3 (SRE)</div>
            <div className="text-center text-slate-400">LEVEL 2 (Auditor)</div>
          </div>
          <div className="divide-y divide-white/10">
            {[
              { name: 'Provision / Revoke IAM Users (iam:manage)', l5: true, l4: false, l3: false, l2: false },
              { name: 'Emergency Circuit Breaker Override (circuit:override)', l5: true, l4: true, l3: false, l2: false },
              { name: 'Authorize & Merge GitOps PRs (gitops:merge)', l5: true, l4: true, l3: true, l2: false },
              { name: 'Ingest Custom Telemetry & Rotate Keys (telemetry:ingest)', l5: true, l4: true, l3: true, l2: false },
              { name: 'Verify Merkle Ledger & Export CERT-In / SBOM (merkle:export)', l5: true, l4: true, l3: true, l2: true },
            ].map((row, idx) => (
              <div key={idx} className="p-4 grid grid-cols-6 items-center hover:bg-white/[0.02]">
                <div className="col-span-2 text-white font-sans font-medium">{row.name}</div>
                <div className="text-center text-emerald-400 font-bold">{row.l5 ? 'ALLOWED' : '—'}</div>
                <div className="text-center text-cyan-300 font-bold">{row.l4 ? 'ALLOWED' : '—'}</div>
                <div className="text-center text-amber-300 font-bold">{row.l3 ? 'ALLOWED' : '—'}</div>
                <div className="text-center text-slate-400">{row.l2 ? 'READ-ONLY' : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AccessManagementPage() {
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Identity &amp; Access Management (IAM) Portal
            </h1>
            <InfoTooltip content="Zero-Trust User Access Management System. Control which emails can sign in, manage RBAC clearance tiers, approve access requests, and grant temporary JIT Break-Glass privileges." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Provision operators, enforce granular capability scopes, approve self-service access requests, and audit every IAM mutation in the Merkle ledger.
          </p>
        </div>
        <div className="flex items-center space-x-2 text-xs font-mono">
          <span className="px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 font-bold flex items-center space-x-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            <span>ZERO-TRUST DIRECTORY ENFORCED</span>
          </span>
        </div>
      </div>

      <UserAccessPortal />
    </div>
  );
}

