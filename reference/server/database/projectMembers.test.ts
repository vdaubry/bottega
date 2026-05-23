import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
  type TestProjectMembersDb,
  type TestProjectsDb,
  type TestUserDb,
} from '../test/db-helper.js';

describe('projectMembersDb', () => {
  let testDb: TestDatabase;
  let userDb: TestUserDb;
  let projectsDb: TestProjectsDb;
  let projectMembersDb: TestProjectMembersDb;
  let testUserId: number;
  let testProjectId: number;

  beforeEach(() => {
    testDb = createTestDatabase();
    userDb = testDb.userDb;
    projectsDb = testDb.projectsDb;
    projectMembersDb = testDb.projectMembersDb;

    // Create a test user
    const user = userDb.createUser('testuser', 'hashedpassword');
    testUserId = user.id;

    // Create a test project (auto-adds creator as member)
    const project = projectsDb.create(testUserId, 'Test Project', '/path/project');
    testProjectId = project.id;
  });

  afterEach(() => {
    testDb.close();
  });

  describe('addMember', () => {
    it('should add a new member to a project', () => {
      const user2 = userDb.createUser('user2', 'password2');

      const result = projectMembersDb.addMember(testProjectId, user2.id);

      expect(result).toBe(true);
      expect(projectMembersDb.isMember(testProjectId, user2.id)).toBe(true);
    });

    it('should return false when adding duplicate member', () => {
      // testUserId is already a member from project creation
      const result = projectMembersDb.addMember(testProjectId, testUserId);

      expect(result).toBe(false);
    });

    it('should allow same user to be member of multiple projects', () => {
      const project2 = projectsDb.create(testUserId, 'Project 2', '/path/project2');

      // User is already member of both projects via create
      expect(projectMembersDb.isMember(testProjectId, testUserId)).toBe(true);
      expect(projectMembersDb.isMember(project2.id, testUserId)).toBe(true);
    });
  });

  describe('removeMember', () => {
    it('should remove a member from a project', () => {
      const user2 = userDb.createUser('user2', 'password2');
      projectMembersDb.addMember(testProjectId, user2.id);

      const result = projectMembersDb.removeMember(testProjectId, user2.id);

      expect(result).toBe(true);
      expect(projectMembersDb.isMember(testProjectId, user2.id)).toBe(false);
    });

    it('should return false when removing non-existent member', () => {
      const user2 = userDb.createUser('user2', 'password2');

      const result = projectMembersDb.removeMember(testProjectId, user2.id);

      expect(result).toBe(false);
    });
  });

  describe('isMember', () => {
    it('should return true for existing member', () => {
      expect(projectMembersDb.isMember(testProjectId, testUserId)).toBe(true);
    });

    it('should return false for non-member', () => {
      const user2 = userDb.createUser('user2', 'password2');

      expect(projectMembersDb.isMember(testProjectId, user2.id)).toBe(false);
    });

    it('should return false for non-existent project', () => {
      expect(projectMembersDb.isMember(9999, testUserId)).toBe(false);
    });
  });

  describe('getProjectMembers', () => {
    it('should return all members of a project', () => {
      const user2 = userDb.createUser('user2', 'password2');
      projectMembersDb.addMember(testProjectId, user2.id);

      const members = projectMembersDb.getProjectMembers(testProjectId);

      expect(members).toHaveLength(2);
      expect(members.map(m => m.username)).toContain('testuser');
      expect(members.map(m => m.username)).toContain('user2');
    });

    it('should return empty array for project with no members', () => {
      // Create a project without auto-membership (simulate orphaned project)
      testDb.db.prepare('INSERT INTO projects (user_id, name, repo_folder_path) VALUES (?, ?, ?)').run(testUserId, 'Orphan', '/orphan');
      const orphanProject = testDb.db
        .prepare('SELECT id FROM projects WHERE repo_folder_path = ?')
        .get('/orphan') as { id: number } | undefined;

      const members = projectMembersDb.getProjectMembers(orphanProject!.id);

      expect(members).toHaveLength(0);
    });

    it('should include joined_at timestamp', () => {
      const members = projectMembersDb.getProjectMembers(testProjectId);

      expect(members[0]!.joined_at).toBeDefined();
    });
  });

  describe('getUserProjects', () => {
    it('should return all projects for a user', () => {
      projectsDb.create(testUserId, 'Project 2', '/path/project2');

      const projects = projectMembersDb.getUserProjects(testUserId);

      expect(projects).toHaveLength(2);
    });

    it('should return empty array for user with no projects', () => {
      const user2 = userDb.createUser('user2', 'password2');

      const projects = projectMembersDb.getUserProjects(user2.id);

      expect(projects).toHaveLength(0);
    });

    it('should include joined_at timestamp', () => {
      const projects = projectMembersDb.getUserProjects(testUserId);

      expect(projects[0]!.joined_at).toBeDefined();
    });
  });

  describe('getMemberCount', () => {
    it('should return correct member count', () => {
      expect(projectMembersDb.getMemberCount(testProjectId)).toBe(1);

      const user2 = userDb.createUser('user2', 'password2');
      projectMembersDb.addMember(testProjectId, user2.id);

      expect(projectMembersDb.getMemberCount(testProjectId)).toBe(2);
    });

    it('should return 0 for non-existent project', () => {
      expect(projectMembersDb.getMemberCount(9999)).toBe(0);
    });
  });

  describe('cascade delete behavior', () => {
    it('should delete memberships when project is deleted', () => {
      const user2 = userDb.createUser('user2', 'password2');
      projectMembersDb.addMember(testProjectId, user2.id);

      expect(projectMembersDb.getMemberCount(testProjectId)).toBe(2);

      projectsDb.delete(testProjectId, testUserId);

      expect(projectMembersDb.getMemberCount(testProjectId)).toBe(0);
    });

    it('should delete memberships when user is deleted', () => {
      const user2 = userDb.createUser('user2', 'password2');
      projectMembersDb.addMember(testProjectId, user2.id);

      expect(projectMembersDb.isMember(testProjectId, user2.id)).toBe(true);

      userDb.deleteUser(user2.id);

      expect(projectMembersDb.isMember(testProjectId, user2.id)).toBe(false);
      expect(projectMembersDb.getMemberCount(testProjectId)).toBe(1);
    });
  });

  describe('project access via membership', () => {
    it('should allow access to project via membership', () => {
      const user2 = userDb.createUser('user2', 'password2');
      projectMembersDb.addMember(testProjectId, user2.id);

      // User2 should be able to access the project via getById
      const project = projectsDb.getById(testProjectId, user2.id);

      expect(project).toBeDefined();
      expect(project!.id).toBe(testProjectId);
    });

    it('should deny access to non-members', () => {
      const user2 = userDb.createUser('user2', 'password2');

      const project = projectsDb.getById(testProjectId, user2.id);

      expect(project).toBeUndefined();
    });
  });
});
