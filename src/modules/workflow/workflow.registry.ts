import { Injectable } from '@nestjs/common';
import { validateDefinition, WorkflowDefinition } from './workflow.types';

/** Workflow definitions registered by domain modules (in their onModuleInit). */
@Injectable()
export class WorkflowRegistry {
  private readonly defs = new Map<string, WorkflowDefinition>();

  register(def: WorkflowDefinition): void {
    validateDefinition(def);
    if (this.defs.has(def.name) && this.defs.get(def.name) !== def) throw new Error(`Workflow ${def.name} is already registered`);
    this.defs.set(def.name, def);
  }

  /** Test helper: forget a definition. */
  unregister(name: string): void {
    this.defs.delete(name);
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.defs.get(name);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }
}
