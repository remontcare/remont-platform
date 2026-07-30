import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationChannel } from '@prisma/client';
import { NotificationEngineService } from './notification-engine.service';

// Phase 2 Stage H — same decoupled pattern as job-ring-policy.service.ts's
// 'job.offer.created' listener: admin.module.ts and partner-registration.module.ts only
// ever emit these event names, never import this file or the engine directly.
@Injectable()
export class AgencyNotificationsService {
  private readonly logger = new Logger(AgencyNotificationsService.name);

  constructor(private engine: NotificationEngineService) {}

  private notify(userId: string, title: string, body: string, type: string, data?: Record<string, any>) {
    return this.engine
      .notify({ userId, title, body, type, data, channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH] })
      .catch((e) => this.logger.warn(`${type} notification failed for user ${userId}: ${e.message}`));
  }

  @OnEvent('agency.approved')
  onAgencyApproved(p: { userId: string; vendorId: string }) {
    return this.notify(p.userId, 'Agency Approved', 'Your agency account is now active. You can start inviting team members.', 'AGENCY_APPROVED', { vendorId: p.vendorId });
  }

  @OnEvent('agency.suspended')
  onAgencySuspended(p: { userId: string; vendorId: string }) {
    return this.notify(p.userId, 'Agency Suspended', 'Your agency account has been suspended by admin. Your team members can keep working independently.', 'AGENCY_SUSPENDED', { vendorId: p.vendorId });
  }

  @OnEvent('member.approved')
  onMemberApproved(p: { agencyOwnerUserId: string; memberName: string; vendorId: string }) {
    return this.notify(p.agencyOwnerUserId, 'Team Member Approved', `${p.memberName} has been approved and joined your team.`, 'MEMBER_APPROVED', { vendorId: p.vendorId });
  }

  @OnEvent('member.rejected')
  onMemberRejected(p: { agencyOwnerUserId: string; memberName: string }) {
    return this.notify(p.agencyOwnerUserId, 'Team Member Application Rejected', `${p.memberName}'s application to join your team was rejected by admin.`, 'MEMBER_REJECTED');
  }

  @OnEvent('member.frozen')
  onMemberFrozen(p: { userId: string; vendorId: string }) {
    return this.notify(p.userId, 'Account Frozen', 'Your partner account has been frozen by admin. Contact support for details.', 'MEMBER_FROZEN', { vendorId: p.vendorId });
  }

  @OnEvent('member.unfrozen')
  onMemberUnfrozen(p: { userId: string; vendorId: string }) {
    return this.notify(p.userId, 'Account Reactivated', 'Your partner account is active again — you can start accepting jobs.', 'MEMBER_UNFROZEN', { vendorId: p.vendorId });
  }

  @OnEvent('member.transferred')
  onMemberTransferred(p: { userId: string; vendorId: string }) {
    return this.notify(p.userId, 'Team Changed', 'You have been transferred to a different agency team.', 'MEMBER_TRANSFERRED', { vendorId: p.vendorId });
  }

  @OnEvent('withdrawal.approved')
  onWithdrawalApproved(p: { userId: string; amount: number; withdrawalId: string }) {
    return this.notify(p.userId, 'Withdrawal Approved', `Your withdrawal request for ₹${p.amount} has been approved and paid out.`, 'WITHDRAWAL_APPROVED', { withdrawalId: p.withdrawalId });
  }

  @OnEvent('withdrawal.rejected')
  onWithdrawalRejected(p: { userId: string; amount: number; withdrawalId: string; note?: string }) {
    return this.notify(p.userId, 'Withdrawal Rejected', `Your withdrawal request for ₹${p.amount} was rejected.${p.note ? ' Reason: ' + p.note : ''}`, 'WITHDRAWAL_REJECTED', { withdrawalId: p.withdrawalId });
  }
}
