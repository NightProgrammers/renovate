export type TGitTag = {
  name: string;
  commit?: {
    created_at?: string;
  };
};

export type TGitCommit = {
  id: string;
};
