import { ApiProperty } from '@nestjs/swagger';
import { ADMIN_UNIT_TYPES, AdminUnitType } from '../entities/admin-unit.entity';

export class AdminUnitDto {
  @ApiProperty({ example: 'WOR-OR-ADAMA' }) id: string;
  @ApiProperty({ enum: ADMIN_UNIT_TYPES }) type: AdminUnitType;
  @ApiProperty({ nullable: true, type: String }) code: string | null;
  @ApiProperty({ example: 'Adama' }) name: string;
  @ApiProperty({ nullable: true, type: String }) nameAm: string | null;
  @ApiProperty({ nullable: true, type: String }) nameOm: string | null;
  @ApiProperty({ nullable: true, type: String }) parentId: string | null;
  @ApiProperty({ example: 'ET.REG_OROMIA.ZONE_OR_ESHEWA.WOR_OR_ADAMA' }) path: string;
  @ApiProperty() active: boolean;
}

export class AdminUnitDetailDto extends AdminUnitDto {
  @ApiProperty({ type: () => [AdminUnitDto], description: 'From the country down to the parent (breadcrumb)' })
  ancestors: AdminUnitDto[];

  @ApiProperty({ description: 'Number of direct children' })
  childCount: number;
}

export class AdminUnitTreeDto extends AdminUnitDto {
  @ApiProperty({ type: () => [AdminUnitTreeDto] })
  children: AdminUnitTreeDto[];
}
