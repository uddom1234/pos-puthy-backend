-- Create the new order_items table
CREATE TABLE `order_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `order_id` INT NOT NULL,
  `product_id` INT NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `quantity` INT NOT NULL,
  `price` DECIMAL(10, 2) NOT NULL,
  `customizations` JSON NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_order_items_order_idx` (`order_id` ASC) VISIBLE,
  INDEX `fk_order_items_product_idx` (`product_id` ASC) VISIBLE,
  CONSTRAINT `fk_order_items_order`
    FOREIGN KEY (`order_id`)
    REFERENCES `orders` (`id`)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_order_items_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `products` (`id`)
    ON DELETE SET NULL
    ON UPDATE NO ACTION
);

-- Migrate data from orders.items to order_items
-- This is a complex migration and will be handled by a script
-- to iterate through each order and its items.
