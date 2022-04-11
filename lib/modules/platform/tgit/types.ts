export interface TGitIssue {
  id: number;
  iid: number;
  title: string;
  labels?: string[];
}

export interface TGitComment {
  body: string;
  id: number;
}

export interface TGitUser {
  id: number;
  username: string;
}

export interface TGitMergeRequest {
  id: number;
  iid: number;
  title: string;
  state: string;
  source_branch: string;
  target_branch: string;
  description: string;
  merge_status: string;
  assignee?: TGitUser;
  reviewers?: TGitUser[];
  labels: string[];
  sha: string;
}

export interface TGitMergeRequestReview {
  id: number;
  iid: number;
  state:
    | 'empty'
    | 'approving'
    | 'approved'
    | 'change_required'
    | 'change_denied';
  reviewers: TGitUser[];
  labels: string[];
}

export interface UpdateMergeRequest {
  target_branch?: string;
  title?: string;
  assignee_id?: number;
  reviewer_ids?: number[];
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface RepoResponse {
  archived: boolean;
  default_branch: string;
  template_repository: boolean;
  ssh_url_to_repo: string;
  http_url_to_repo: string;
  forked_from_project: string;
  merge_requests_enabled: boolean;
  path_with_namespace: string;
  merge_method?: MergeMethod;
}

export interface TGitUserStatus {
  state: 'active' | string;
}
